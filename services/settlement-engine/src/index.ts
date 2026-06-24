/**
 * Settlement Engine — BettaPay Backend
 *
 * Handles settlement processing with fee deduction and audit trail.
 *
 * Endpoints:
 *   GET  /api/health              — liveness and Redis connectivity probe
 *   GET  /api/settlements         — list all settlements
 *   POST /api/settlements         — create and process a settlement
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client/runtime/client';
import {
  validateEnv,
  CreateSettlementBody,
} from "@bettapay/validation";
import { Queue, Worker } from 'bullmq';

interface CreateSettlementRouteBody {
  merchantId?: unknown;
  amount?: unknown;
  asset?: unknown;
}

const env = validateEnv(process.env);
const PORT = Number(process.env.PORT ?? '3001');
const startTime = Date.now();

const prisma = new PrismaClient();

type SettlementJobData = {
  id: string;
  merchantId: string;
  grossAmount: string;
  asset: string;
};

const fastify = Fastify({ 
  logger: true,
  // Explicitly set body limit to 1MB (Fastify's default)
  bodyLimit: 1_048_576,
  genReqId: function (req) {
    return (req.headers['x-request-id'] as string) || crypto.randomUUID();
  }
});

fastify.register(cors, { 
  origin: env.ALLOWED_ORIGINS.split(',').map((o: string) => o.trim()) 
});

const redisConnection = new URL(env.REDIS_URL);
const connectionParams = {
  host: redisConnection.hostname,
  port: parseInt(redisConnection.port || '6379', 10),
};

const settlementQueue = new Queue('settlements', { connection: connectionParams });

new Worker('settlements', async job => {
  fastify.log.info({
    jobId: job.id,
    merchantId: job.data.merchantId,
    amount: job.data.totalAmount,
    asset: job.data.asset,
    jobName: job.name
  }, 'Processing settlement job');
  // In a real app, this interacts with Soroban
}, {
  connection: connectionParams,
  concurrency: 5,
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
});

// In-memory store for development (Gateway uses DB, this worker processes memory queue)
const settlements: Settlement[] = [];

// Reads a merchant's fee rule (basis points) from Merchant.settings JSON. Falls
// back to the configurable default when the merchant is missing or has no rule.
async function fetchMerchantFeeBps(merchantId: string): Promise<number> {
  const merchant = await prisma.merchant.findUnique({ where: { id: merchantId } });
  const settings = merchant?.settings as { feeBps?: number } | null | undefined;
  const feeBps = settings?.feeBps;
  return typeof feeBps === 'number' && Number.isFinite(feeBps) ? feeBps : env.FEES_DEFAULT_BPS;
}

fastify.get('/api/health', async (_request, reply) => {
  let redisConnected = false;

  try {
    await settlementQueue.getJobCounts();
    redisConnected = true;
  } catch (error) {
    fastify.log.warn({ error }, 'Settlement Redis health check failed');
  }

  return reply.code(200).send({
    status: redisConnected ? 'ok' : 'degraded',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    redis: {
      connected: redisConnected,
    },
  });
});

fastify.get('/api/settlements', async (request, reply) => {
  const records = await prisma.settlement.findMany({
    orderBy: { initiatedAt: 'desc' },
  });
  return { settlements: records, total: records.length };
});

fastify.post<{ Body: CreateSettlementRouteBody }>('/api/settlements', async (request, reply) => {
  try {
    const d = CreateSettlementBody.parse(request.body);
    const gross = parseFloat(d.amount ?? '0');
    if (gross <= 0) return reply.code(400).send({ error: 'amount must be > 0' });

    const settlement = await prisma.settlement.create({
      data: {
        id: 'set_' + crypto.randomUUID().replace(/-/g, ''),
        merchantId: d.merchantId,
        totalAmount: d.amount,
        asset: d.asset,
        status: 'pending',
      },
    });

    const jobData: SettlementJobData = {
      id: settlement.id,
      merchantId: settlement.merchantId,
      grossAmount: d.amount,
      asset: d.asset,
    };

    await settlementQueue.add('process-settlement', jobData, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
    });

    return reply.code(201).send(settlement);
  } catch (error) {
    return reply.code(400).send({ error: 'Invalid request payload' });
  }
});

const start = async () => {
  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};
start();
