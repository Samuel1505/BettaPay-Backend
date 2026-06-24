/**
 * Settlement Engine — BettaPay Backend
 *
 * Handles settlement processing with fee deduction and audit trail.
 *
 * Endpoints:
 *   GET  /api/health              — liveness and Redis connectivity probe
 *   GET  /api/settlements         — list all settlements
 *   POST /api/settlements         — create and process a settlement
 *
 * Precision strategy
 * ──────────────────
 * All monetary arithmetic uses BigNumber.js (ROUND_DOWN, no floating-point).
 * Fee basis points are applied as:
 *   feeAmount  = floor(grossAmount × feeBps / 10 000, asset decimals)
 *   netAmount  = grossAmount − feeAmount
 *
 * All three amounts (grossAmount, feeAmount, netAmount) are stored as
 * decimal strings so the database never loses sub-cent precision for
 * assets like USDC (6 dp) or XLM (7 dp).
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import crypto from 'crypto';
import Redis from 'ioredis';
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

const redis = new Redis(env.REDIS_URL);

fastify.addHook('onClose', async () => {
  await redis.quit();
});

fastify.register(cors, { 
  origin: env.ALLOWED_ORIGINS.split(',').map((o: string) => o.trim()) 
});

fastify.register(helmet, { contentSecurityPolicy: false });

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

fastify.get('/api/settlements', async (_request, reply) => {
  const records = await prisma.settlement.findMany({
    orderBy: { initiatedAt: 'desc' },
  });
  return { settlements: records, total: records.length };
});

fastify.post<{ Body: CreateSettlementRouteBody }>('/api/settlements', async (request, reply) => {
  try {
    const d = CreateSettlementBody.parse(request.body);

    // Validate that the amount is positive without floating-point conversion
    const grossBN = new BigNumber(d.amount ?? '0');
    if (!grossBN.isFinite() || grossBN.isLessThanOrEqualTo(0)) {
      return reply.code(400).send({ error: 'amount must be > 0' });
    }

    const feeBps = await fetchMerchantFeeBps(d.merchantId);
    const { grossAmount, feeAmount, netAmount } = computeSettlementAmounts(d.amount, feeBps);

    const rawIdempotencyKey = request.headers['idempotency-key'];
    const idempotencyKey = Array.isArray(rawIdempotencyKey) ? rawIdempotencyKey[0] : rawIdempotencyKey;

    if (idempotencyKey) {
      const existingSettlementId = await redis.get(`idempotency:${idempotencyKey}`);
      if (existingSettlementId) {
        const existingSettlement = await prisma.settlement.findUnique({
          where: { id: existingSettlementId },
        });
        if (existingSettlement) {
          return reply.code(200).send(existingSettlement);
        }
      }
    }

    const settlement = await prisma.settlement.create({
      data: {
        id: 'set_' + crypto.randomUUID().replace(/-/g, ''),
        merchantId: d.merchantId,
        totalAmount: grossAmount,
        grossAmount,
        feeAmount,
        netAmount,
        feeBps,
        asset: d.asset,
        status: 'pending',
      },
    });

    const jobData: SettlementJobData = {
      id: settlement.id,
      merchantId: settlement.merchantId,
      grossAmount: settlement.grossAmount,
      asset: settlement.asset,
    };

    await settlementQueue.add('process-settlement', jobData, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
    });

    if (idempotencyKey) {
      // 24-hour TTL (24 * 60 * 60 = 86400 seconds)
      await redis.set(`idempotency:${idempotencyKey}`, settlement.id, 'EX', 86400);
    }

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
