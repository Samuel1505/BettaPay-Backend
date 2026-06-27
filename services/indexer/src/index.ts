/**
 * Indexer Service — BettaPay Backend
 *
 * Listens to Soroban contract event streams and indexes payment/settlement events.
 * Polls the Stellar RPC for contract events on the SETTLEMENT_CONTRACT_ID.
 *
 * Endpoints:
 *   GET /api/events              — list indexed events (newest first, max 50)
 *   GET /api/health              — liveness probe
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import crypto from 'crypto';
import { rpc } from '@stellar/stellar-sdk';
import { validateEnv, registerErrorHandler, PaginationQuery, EVENT_TYPES } from '@bettapay/validation';
import type { IndexedEvent, EventType } from '@bettapay/validation';

const env = validateEnv(process.env);
const PORT = Number(process.env.PORT ?? '3003');

const fastify = Fastify({ logger: true });

fastify.register(cors, {
  origin: env.ALLOWED_ORIGINS
});
registerErrorHandler(fastify);

// In-memory event ring buffer (50 events max)
const events: IndexedEvent[] = [];
let latestLedgerCursor: number | undefined = undefined;

// Backoff state for polling loop
const BASE_BACKOFF = 1000;
const MAX_BACKOFF = 30000;
let currentBackoff = BASE_BACKOFF;

function pushEvent(topics: string[], type: EventType, contractId: string, rawValue: string, ledger: number): IndexedEvent {
  const event: IndexedEvent = {
    id: 'evt_' + crypto.randomUUID().replace(/-/g, ''),
    contractId,
    topics,
    type,
    rawValue,
    ledger,
    indexedAt: new Date().toISOString(),
  };
  events.unshift(event);
  if (events.length > 50) events.pop();
  fastify.log.info(`[Indexer] ${topics.join(',')} — ${event.id} (Ledger ${ledger})`);
  return event;
}

// HTTP API
fastify.get('/api/health', async (request, reply) => {
  return { status: 'ok', indexedEvents: events.length, latestLedgerCursor };
});

fastify.get('/api/events', async (request, reply) => {
  const { limit, offset } = PaginationQuery.parse(request.query ?? {});
  const typeParam = (request.query as Record<string, unknown>)?.type as string | undefined;

  let filteredEvents = events;

  if (typeParam) {
    const requestedTypes = typeParam.split(',').map((t: string) => t.trim()) as EventType[];
    const validTypes = requestedTypes.filter((t): t is EventType => (EVENT_TYPES as readonly string[]).includes(t));

    if (validTypes.length > 0) {
      filteredEvents = events.filter((event) => validTypes.includes(event.type));
    }
  }

  const paginatedEvents = filteredEvents.slice(offset, offset + limit);
  return { events: paginatedEvents, total: filteredEvents.length, latestLedgerCursor };
});

const server = new rpc.Server(env.STELLAR_RPC_URL, { allowHttp: true });

async function pollEvents() {
  try {
    if (!latestLedgerCursor) {
      const latest = await server.getLatestLedger();
      latestLedgerCursor = latest.sequence;
    }

    const request = {
      startLedger: latestLedgerCursor,
      filters: [
        {
          type: 'contract' as const,
          contractIds: [env.SETTLEMENT_CONTRACT_ID],
          topics: [],
        }
      ],
      limit: 100,
    };

    const response = await server.getEvents(request);

    if (response.events && response.events.length > 0) {
      for (const evt of response.events) {
        const topics = Array.isArray(evt.topic) ? evt.topic.map(String) : [String(evt.topic)];
        pushEvent(
          topics,
          topics[0] as EventType,
          evt.contractId ? evt.contractId.toString() : 'unknown',
          evt.value.toXDR('base64'),
          evt.ledger
        );
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

const start = async () => {
  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    fastify.log.info('[Indexer] Starting Stellar RPC polling loop...');
    pollEvents();
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};
start();
