/**
 * Indexer Service — BettaPay Backend
 *
 * Listens to Soroban contract event streams and indexes payment/settlement events.
 * Polls the Stellar RPC for contract events on the SETTLEMENT_CONTRACT_ID.
 *
 * Endpoints:
 *   GET  /api/events              — list indexed events (paginated, from DB)
 *   POST /api/events/replay       — re-index events for a historical ledger range
 *   POST /api/webhooks            — register a webhook URL subscription
 *   GET  /api/webhooks            — list all webhook subscriptions
 *   DELETE /api/webhooks/:id      — unsubscribe a webhook
 *   GET  /api/health              — liveness probe
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import crypto from 'crypto';
import { Redis } from 'ioredis';
import { Queue, Worker } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { rpc, scValToNative, xdr } from '@stellar/stellar-sdk';
import { z } from 'zod';
import {
  validateEnv,
  registerErrorHandler,
  PaginationQuery,
  EVENT_TYPES,
  connectWithRetry,
} from '@bettapay/validation';
import type { EventType } from '@bettapay/validation';

const env = validateEnv(process.env);
const PORT = Number(process.env.PORT ?? '3003');

const fastify = Fastify({ logger: true });
const prisma = new PrismaClient();

fastify.register(cors, { origin: env.ALLOWED_ORIGINS });
registerErrorHandler(fastify);

// Polling state
let latestLedgerCursor: number | undefined = undefined;
const BASE_BACKOFF = 1000;
const MAX_BACKOFF = 30000;
let currentBackoff = BASE_BACKOFF;

// ── BullMQ webhook delivery queue ────────────────────────────────────────────

const redisConn = new URL(env.REDIS_URL);
const connectionParams = {
  host: redisConn.hostname,
  port: parseInt(redisConn.port || '6379', 10),
  maxRetriesPerRequest: 3,
};

const webhookQueue = new Queue('indexer-webhooks', {
  connection: connectionParams,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 500 },
  },
});

const webhookWorker = new Worker<{ url: string; event: Record<string, unknown> }>(
  'indexer-webhooks',
  async (job) => {
    const { url, event } = job.data;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      fastify.log.info({ url, jobId: job.id }, '[Indexer] Webhook delivered');
    } catch (err) {
      clearTimeout(timeoutId);
      throw err;
    }
  },
  { connection: connectionParams, concurrency: 10 }
);

webhookWorker.on('error', (err) => {
  fastify.log.error({ err: err.message }, '[Indexer] Webhook worker error');
});
webhookQueue.on('error', (err) => {
  fastify.log.error({ err: err.message }, '[Indexer] Webhook queue error');
});

// ── XDR decoding ─────────────────────────────────────────────────────────────

function serializeNative(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Buffer || Buffer.isBuffer(value)) return (value as Buffer).toString('hex');
  if (Array.isArray(value)) return value.map(serializeNative);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, serializeNative(v)])
    );
  }
  return value;
}

function decodeScVal(evtValue: xdr.ScVal, topicHint: string): unknown {
  try {
    const native = scValToNative(evtValue);
    return serializeNative(native);
  } catch (err) {
    fastify.log.warn({ topicHint, err: String(err) }, '[Indexer] Failed to decode XDR — raw value preserved');
    return null;
  }
}

// ── Event persistence ─────────────────────────────────────────────────────────

async function persistEvent(
  stellarId: string | null,
  topics: string[],
  type: string,
  contractId: string,
  rawValue: string,
  decodedPayload: unknown,
  ledger: number
): Promise<Record<string, unknown>> {
  const id = 'evt_' + crypto.randomUUID().replace(/-/g, '');

  const record = await prisma.indexedEvent.create({
    data: {
      id,
      stellarId,
      contractId,
      topics,
      type,
      rawValue,
      decodedPayload: decodedPayload !== null ? (decodedPayload as any) : undefined,
      ledger,
      indexedAt: new Date(),
    },
  });

  fastify.log.info({ id, type, ledger }, '[Indexer] Event indexed');

  const subs = await prisma.webhookSubscription.findMany();
  for (const sub of subs) {
    await webhookQueue.add('deliver', { url: sub.url, event: record as Record<string, unknown> });
  }

  return record as Record<string, unknown>;
}

// ── HTTP API ──────────────────────────────────────────────────────────────────

fastify.get('/api/health', async () => {
  return { status: 'ok', latestLedgerCursor };
});

// Issue #67 — paginated events endpoint with { total, limit, offset, hasMore }
fastify.get('/api/events', async (request) => {
  const { limit, offset } = PaginationQuery.parse(request.query ?? {});
  const typeParam = (request.query as Record<string, unknown>)?.type as string | undefined;

  const where: Record<string, unknown> = {};
  if (typeParam) {
    const requestedTypes = typeParam.split(',').map((t) => t.trim());
    const validTypes = requestedTypes.filter((t): t is EventType =>
      (EVENT_TYPES as readonly string[]).includes(t)
    );
    if (validTypes.length > 0) where.type = { in: validTypes };
  }

  const [dbEvents, total] = await Promise.all([
    prisma.indexedEvent.findMany({
      where,
      take: limit,
      skip: offset,
      orderBy: { indexedAt: 'desc' },
    }),
    prisma.indexedEvent.count({ where }),
  ]);

  const hasMore = offset + limit < total;
  return { events: dbEvents, total, limit, offset, hasMore, latestLedgerCursor };
});

// Issue #68 — replay historical events for a ledger range
const ReplayBody = z.object({
  fromLedger: z.number().int().min(1),
  toLedger: z.number().int().min(1),
}).refine((d) => d.fromLedger <= d.toLedger, {
  message: 'fromLedger must be <= toLedger',
});

fastify.post('/api/events/replay', async (request, reply) => {
  const { fromLedger, toLedger } = ReplayBody.parse(request.body);

  let newEvents = 0;
  let skippedDuplicates = 0;
  let cursor = fromLedger;

  while (cursor <= toLedger) {
    const response = await server.getEvents({
      startLedger: cursor,
      filters: [{ type: 'contract' as const, contractIds: [env.SETTLEMENT_CONTRACT_ID], topics: [] }],
      limit: 100,
    });

    if (!response.events || response.events.length === 0) break;

    for (const evt of response.events) {
      if (evt.ledger > toLedger) break;
      cursor = Math.max(cursor, evt.ledger + 1);

      const topics = Array.isArray(evt.topic) ? evt.topic.map(String) : [String(evt.topic)];
      const rawValue = evt.value.toXDR('base64');
      const decodedPayload = decodeScVal(evt.value, topics[0]);
      const contractId = evt.contractId ? evt.contractId.toString() : 'unknown';
      const stellarId = typeof evt.id === 'string' ? evt.id : null;

      // Skip duplicates using Stellar's own event ID (most reliable key)
      if (stellarId) {
        const existing = await prisma.indexedEvent.findUnique({ where: { stellarId } });
        if (existing) {
          skippedDuplicates++;
          continue;
        }
      } else {
        // Fall back to ledger + contractId + rawValue fingerprint
        const existing = await prisma.indexedEvent.findFirst({
          where: { ledger: evt.ledger, contractId, rawValue },
        });
        if (existing) {
          skippedDuplicates++;
          continue;
        }
      }

      await prisma.indexedEvent.create({
        data: {
          id: 'evt_' + crypto.randomUUID().replace(/-/g, ''),
          stellarId,
          contractId,
          topics,
          type: topics[0],
          rawValue,
          decodedPayload: decodedPayload !== null ? (decodedPayload as any) : undefined,
          ledger: evt.ledger,
          indexedAt: new Date(),
        },
      });
      newEvents++;
    }

    const lastEvt = response.events[response.events.length - 1];
    if (lastEvt.ledger >= toLedger || response.events.length < 100) break;
  }

  return reply.code(200).send({ newEvents, skippedDuplicates });
});

// Issue #70 — webhook subscription CRUD
const WebhookBody = z.object({
  url: z.string().url('url must be a valid URL'),
});

fastify.post('/api/webhooks', async (request, reply) => {
  const { url } = WebhookBody.parse(request.body);
  const sub = await prisma.webhookSubscription.create({
    data: { id: 'wh_' + crypto.randomUUID().replace(/-/g, ''), url },
  });
  return reply.code(201).send(sub);
});

fastify.get('/api/webhooks', async () => {
  return prisma.webhookSubscription.findMany({ orderBy: { createdAt: 'desc' } });
});

fastify.delete<{ Params: { id: string } }>('/api/webhooks/:id', async (request, reply) => {
  const { id } = request.params;
  const existing = await prisma.webhookSubscription.findUnique({ where: { id } });
  if (!existing) {
    return reply.code(404).send({
      error: { code: 'NOT_FOUND', message: `Webhook subscription ${id} not found` },
    });
  }
  await prisma.webhookSubscription.delete({ where: { id } });
  return reply.code(204).send();
});

// ── Stellar RPC polling loop ──────────────────────────────────────────────────

const server = new rpc.Server(env.STELLAR_RPC_URL, { allowHttp: true });

async function pollEvents() {
  try {
    if (!latestLedgerCursor) {
      const latest = await server.getLatestLedger();
      latestLedgerCursor = latest.sequence;
    }

    const response = await server.getEvents({
      startLedger: latestLedgerCursor,
      filters: [
        {
          type: 'contract' as const,
          contractIds: [env.SETTLEMENT_CONTRACT_ID],
          topics: [],
        },
      ],
      limit: 100,
    });

    if (response.events && response.events.length > 0) {
      for (const evt of response.events) {
        const topics = Array.isArray(evt.topic) ? evt.topic.map(String) : [String(evt.topic)];
        const rawValue = evt.value.toXDR('base64');
        const decodedPayload = decodeScVal(evt.value, topics[0]);
        const contractId = evt.contractId ? evt.contractId.toString() : 'unknown';
        const stellarId = typeof evt.id === 'string' ? evt.id : null;

        await persistEvent(stellarId, topics, topics[0], contractId, rawValue, decodedPayload, evt.ledger);
        latestLedgerCursor = Math.max(latestLedgerCursor, evt.ledger + 1);
      }
    } else {
      const latest = await server.getLatestLedger();
      latestLedgerCursor = Math.max(latestLedgerCursor, latest.sequence);
    }

    currentBackoff = BASE_BACKOFF;
    setTimeout(pollEvents, currentBackoff);
  } catch (err) {
    fastify.log.error(`[Indexer] Polling error: ${err}`);
    const jitter = currentBackoff * (0.75 + Math.random() * 0.5);
    fastify.log.info(`[Indexer] Retrying in ${Math.round(jitter)}ms (backoff: ${currentBackoff}ms)`);
    currentBackoff = Math.min(currentBackoff * 2, MAX_BACKOFF);
    setTimeout(pollEvents, jitter);
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────

const start = async () => {
  try {
    await connectWithRetry(prisma, fastify.log);
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    fastify.log.info('[Indexer] Starting Stellar RPC polling loop...');
    pollEvents();
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

process.on('SIGTERM', async () => {
  await prisma.$disconnect();
  await webhookQueue.close();
  await webhookWorker.close();
  await fastify.close();
  process.exit(0);
});

start();
