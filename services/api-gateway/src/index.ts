/**
 * API Gateway — BettaPay Backend
 *
 * Unified REST entry point for the BettaPay platform.
 * Handles merchant registration, payment sessions, and settlement requests.
 *
 * Endpoints:
 *   GET    /api/health               — liveness probe
 *   POST   /api/auth/token           — login / get JWT
 *   POST   /api/merchants            — register merchant (protected)
 *   GET    /api/merchants/:id        — fetch merchant (protected)
 *   DELETE /api/merchants/:id        — soft-delete merchant (protected)
 *   POST   /api/merchants/:id/restore — restore soft-deleted merchant (protected)
 *   PATCH  /api/merchants/:id/settings — update merchant fee rules / settings (protected)
 *   POST   /api/payments             — initiate payment session (protected)
 *   GET    /api/payments/:id         — fetch payment session
 *   PATCH  /api/payments/:id/status  — transition payment status (protected)
 *   POST   /api/settlements          — trigger settlement (protected)
 *   GET    /api/deployments          — Soroban contract addresses (testnet)
 */

import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import crypto from 'crypto';
import { z } from 'zod';
import { validateEnv } from '@bettapay/validation';
import {
  CreateMerchantBody,
  CreatePaymentBody,
  CreateSettlementBody,
  AuthTokenBody,
  UpdatePaymentStatusBody,
  UpdateMerchantSettingsBody,
  createErrorResponse,
  ErrorCodes
} from '@bettapay/validation';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import helmet from '@fastify/helmet';
import { PrismaPg } from '@prisma/adapter-pg';

declare module 'fastify' {
  export interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

interface MerchantParams {
  id: string;
}

interface PaymentParams {
  id: string;
}

interface AuthTokenRouteBody {
  merchantId?: unknown;
}

interface CreateMerchantRouteBody {
  id?: unknown;
  name?: unknown;
  ownerId?: unknown;
  settings?: unknown;
}

interface CreatePaymentRouteBody {
  merchantId?: unknown;
  payerId?: unknown;
  amount?: unknown;
  asset?: unknown;
  reference?: unknown;
}

interface CreateSettlementRouteBody {
  merchantId?: unknown;
  amount?: unknown;
  asset?: unknown;
}

interface UpdateMerchantSettingsRouteBody {
  feeBps?: unknown;
  tier?: unknown;
}

interface UpdatePaymentStatusRouteBody {
  status?: unknown;
}

// Allowed payment status transitions. `initiated` is the only non-terminal state;
// completed, failed, and cancelled are terminal and cannot transition further.
const PAYMENT_STATUS_TRANSITIONS: Record<string, readonly string[]> = {
  initiated: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

const isProduction = process.env.NODE_ENV === 'production';

const env = validateEnv(process.env);
const PORT = Number(process.env.PORT ?? '3000');

// --- Request lifecycle timeouts ---------------------------------------------
// REQUEST_TIMEOUT_MS bounds how long a single request may run. If a handler
// (e.g. a slow DB query or a hung upstream service) exceeds it, the per-request
// hook below replies 408 Request Timeout so the client connection is released
// instead of being held open and exhausting the connection pool.
//
// CONNECTION_TIMEOUT_MS is the socket-level backstop (set 1s higher). It closes
// any connection the request timeout did not already finish.
//
// IMPORTANT: keep both values BELOW any upstream load balancer / reverse proxy
// idle timeout (commonly 60s) so this gateway returns a clean 408 rather than
// the load balancer cutting the connection first.
const REQUEST_TIMEOUT_MS = 30_000;
const CONNECTION_TIMEOUT_MS = 31_000;

const fastify = Fastify({
  logger: true,
  requestTimeout: REQUEST_TIMEOUT_MS,
  connectionTimeout: CONNECTION_TIMEOUT_MS,
  // Limit request body size to 1MB (1,048,576 bytes) to protect the API gateway
  // from oversized payload attacks and align with typical financial transaction payload sizes.
  bodyLimit: 1_048_576,
  genReqId: function (req) {
    return (req.headers['x-request-id'] as string) || crypto.randomUUID();
  }
});

// --- Response logging hooks -------------------------------------------------
const SENSITIVE_FIELDS = new Set(['token', 'secret', 'secretHash', 'password', 'privateKey', 'secretKey']);
const CONTROL_CHARS_EXCEPT_NEWLINES_AND_TABS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function sanitizeString(value: string): string {
  return value
    .trim()
    .replace(CONTROL_CHARS_EXCEPT_NEWLINES_AND_TABS, '')
    .normalize('NFC');
}

function sanitizeInput(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') {
    return sanitizeString(value);
  }

  if (Array.isArray(value)) {
    return value.map(item => sanitizeInput(item, seen));
  }

  if (value && typeof value === 'object') {
    if (seen.has(value)) return value;
    seen.add(value);

    const record = value as Record<string, unknown>;
    for (const [key, nestedValue] of Object.entries(record)) {
      record[key] = sanitizeInput(nestedValue, seen);
    }
  }

  return value;
}

function redactValue(value: any): any {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value === 'object') return redactObject(value);
  return value;
}

function redactObject(obj: Record<string, any>) {
  const out: Record<string, any> = {};
  for (const k of Object.keys(obj)) {
    try {
      if (SENSITIVE_FIELDS.has(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactValue(obj[k]);
      }
    } catch (e) {
      out[k] = '[REDACTION_ERROR]';
    }
  }
  return out;
}

fastify.addHook('onRequest', async (request, reply) => {
  // Mark request start for response time calculation
  (request as any).__startTime = Date.now();

  // Per-request timeout guard. Fastify's requestTimeout only bounds how long the
  // client takes to *send* a request; it does not abort a slow handler. This timer
  // covers that case: if the response is not sent within REQUEST_TIMEOUT_MS, reply
  // 408 so the caller is not left hanging. (The slow handler keeps running, but the
  // client connection is freed.) The timer is cleared in the onResponse hook below.
  const timeoutTimer = setTimeout(() => {
    if (!reply.sent) {
      reply.code(408).send(createErrorResponse(ErrorCodes.REQUEST_TIMEOUT, 'Request Timeout'));
    }
  }, REQUEST_TIMEOUT_MS);
  (request as any).__timeoutTimer = timeoutTimer;
});

fastify.addHook('onResponse', async (request) => {
  const timeoutTimer = (request as any).__timeoutTimer;
  if (timeoutTimer) clearTimeout(timeoutTimer);
});

fastify.addHook('onSend', async (request, reply, payload) => {
  try {
    const headers = request.headers as Record<string, any>;
    const reqId = (headers['x-request-id'] as string) || (request.id as string) || 'unknown';
    const method = request.method;
    const url = request.url;
    const statusCode = reply.statusCode || 0;
    const start = (request as any).__startTime || Date.now();
    const responseTime = Date.now() - start;

    const baseLog = { reqId, method, url, statusCode, responseTime };

    if (statusCode >= 400) {
      // attempt to parse payload (may be string, Buffer, object)
      let body: any = payload;
      try {
        if (typeof payload === 'string') body = JSON.parse(payload as string);
      } catch (e) {
        // leave as raw string
      }

      const safeBody = typeof body === 'object' && body !== null ? redactObject(body as Record<string, any>) : body;
      fastify.log.warn({ ...baseLog, response: safeBody }, 'Error response');
    } else {
      fastify.log.info(baseLog, 'Response summary');
    }
  } catch (err) {
    fastify.log.error({ err }, 'onSend hook failed');
  }

  return payload;
});

const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// Setup plugins
fastify.register(helmet, { contentSecurityPolicy: false, hsts: { maxAge: 31536000 }, referrerPolicy: { policy: 'no-referrer' } });

fastify.register(cors, {
  origin: env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
});

fastify.register(fastifyJwt, {
  secret: env.JWT_SECRET,
  sign: {
    expiresIn: env.JWT_EXPIRES_IN
  }
});

// Rate limiting: global default and route overrides
fastify.register(rateLimit, {
  max: 1000,
  timeWindow: '1 minute',
  addHeaders: true
});

fastify.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
});

// Request body logging for mutation endpoints
async function logRequestBody(request: FastifyRequest, reply: FastifyReply) {
  if (request.body && typeof request.body === 'object') {
    const cloned = JSON.parse(JSON.stringify(request.body));
    for (const key of SENSITIVE_FIELDS) {
      if (key in cloned) {
        cloned[key] = '[REDACTED]';
      }
    }
    const logLevel = isProduction ? 'debug' : 'info';
    request.log[logLevel]({ requestId: request.id, body: cloned }, 'incoming request body');
  }
}

// Maps a thrown parse error to the standard 400 envelope. Zod failures carry the
// issue list in `details`; anything else falls back to a generic invalid request.
function badRequest(reply: FastifyReply, error: unknown) {
  if (error instanceof z.ZodError) {
    return reply.code(400).send(createErrorResponse(ErrorCodes.VALIDATION_ERROR, 'Validation failed', error.errors));
  }
  return reply.code(400).send(createErrorResponse(ErrorCodes.INVALID_REQUEST, 'Invalid request payload'));
}

// Authentication hook
fastify.decorate('authenticate', async function (request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify();
  } catch (err) {
    request.log.error(err);
    reply.code(401).send(createErrorResponse(ErrorCodes.UNAUTHORIZED, 'Unauthorized'));
  }
});

fastify.addHook('preHandler', async (request) => {
  if (request.body !== undefined) {
    request.body = sanitizeInput(request.body);
  }
});

// Zod validation runs inside route handlers after this global preHandler, so
// schemas receive trimmed, control-character-free, NFC-normalized strings.

// Routes
fastify.get('/api/health', async (request, reply) => {
  const startTime = Date.now();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    const dbPromise = prisma.$queryRaw`SELECT 1`;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('Database query timed out')), 3000);
    });

    await Promise.race([dbPromise, timeoutPromise]);

    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    const latencyMs = Date.now() - startTime;
    return {
      status: 'healthy',
      env: env.NODE_ENV,
      db: {
        connected: true,
        latencyMs
      }
    };
  } catch (error) {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    fastify.log.error(error);
    return {
      status: 'degraded',
      env: env.NODE_ENV,
      db: {
        connected: false
      }
    };
  }
});

fastify.post<{ Body: AuthTokenRouteBody }>('/api/auth/token', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
  try {
    const d = AuthTokenBody.parse(request.body);
    const merchant = await prisma.merchant.findFirst({ where: { id: d.merchantId, deletedAt: null } });
    if (!merchant) return reply.code(404).send(createErrorResponse(ErrorCodes.NOT_FOUND, 'Merchant not found'));

    // In a real system, you would verify the secret/password here.
    // For this example, we'll just issue a token if the merchant exists.
    const token = fastify.jwt.sign({ merchantId: merchant.id, ownerId: merchant.ownerId });
    return reply.send({ token });
  } catch (error) {
    return badRequest(reply, error);
  }
});

// Merchants
fastify.post<{ Body: CreateMerchantRouteBody }>('/api/merchants', {
  preValidation: [fastify.authenticate],
  preHandler: [logRequestBody],
  config: { rateLimit: { max: 30, timeWindow: '1 minute' } }
}, async (request, reply) => {
  try {
    const d = CreateMerchantBody.parse(request.body);
    const merchant = await prisma.merchant.create({
      data: {
        id: d.id,
        name: d.name,
        ownerId: d.ownerId || 'unknown',
        settings: d.settings ?? {},
      }
    });
    return reply.code(201).send({ success: true, merchant });
  } catch (error) {
    return badRequest(reply, error);
  }
});

fastify.get<{ Params: MerchantParams }>('/api/merchants/:id', {
  preValidation: [fastify.authenticate]
}, async (request, reply) => {
  const { id } = request.params;
  const merchant = await prisma.merchant.findFirst({
    where: { id, deletedAt: null },
  });
  if (!merchant) return reply.code(404).send(createErrorResponse(ErrorCodes.NOT_FOUND, 'Merchant not found'));
  return merchant;
});

fastify.delete<{ Params: MerchantParams }>('/api/merchants/:id', {
  preValidation: [fastify.authenticate],
  config: { rateLimit: { max: 30, timeWindow: '1 minute' } }
}, async (request, reply) => {
  const { id } = request.params;
  const merchant = await prisma.merchant.findFirst({
    where: { id, deletedAt: null },
  });
  if (!merchant) return reply.code(404).send(createErrorResponse(ErrorCodes.NOT_FOUND, 'Merchant not found'));

  await prisma.merchant.update({
    where: { id },
    data: { deletedAt: new Date() },
  });

  return reply.code(200).send({ success: true });
});

fastify.post<{ Params: MerchantParams }>('/api/merchants/:id/restore', {
  preValidation: [fastify.authenticate],
  config: { rateLimit: { max: 30, timeWindow: '1 minute' } }
}, async (request, reply) => {
  const { id } = request.params;
  const merchant = await prisma.merchant.findUnique({ where: { id } });
  if (!merchant) return reply.code(404).send(createErrorResponse(ErrorCodes.NOT_FOUND, 'Merchant not found'));
  if (!merchant.deletedAt) {
    return reply.code(400).send(createErrorResponse(ErrorCodes.INVALID_REQUEST, 'Merchant is not soft-deleted'));
  }

  const restored = await prisma.merchant.update({
    where: { id },
    data: { deletedAt: null },
  });

  return reply.code(200).send({ success: true, merchant: restored });
});

// Update per-merchant settings (fee rules, tier). Merges into existing settings so
// a partial update does not wipe unrelated keys. The settlement engine reads
// settings.feeBps from here when computing fees.
fastify.patch<{ Params: MerchantParams; Body: UpdateMerchantSettingsRouteBody }>('/api/merchants/:id/settings', {
  preValidation: [fastify.authenticate],
  preHandler: [logRequestBody],
  config: { rateLimit: { max: 30, timeWindow: '1 minute' } }
}, async (request, reply) => {
  let d;
  try {
    d = UpdateMerchantSettingsBody.parse(request.body);
  } catch (error) {
    return badRequest(reply, error);
  }

  const { id } = request.params;
  const merchant = await prisma.merchant.findFirst({ where: { id, deletedAt: null } });
  if (!merchant) return reply.code(404).send(createErrorResponse(ErrorCodes.NOT_FOUND, 'Merchant not found'));

  const currentSettings = (merchant.settings ?? {}) as Record<string, unknown>;
  const nextSettings = { ...currentSettings, ...d };

  const updated = await prisma.merchant.update({
    where: { id },
    data: { settings: nextSettings as object },
  });

  return reply.code(200).send({ success: true, merchant: updated });
});

// Payments
fastify.post<{ Body: CreatePaymentRouteBody }>('/api/payments', {
  preValidation: [fastify.authenticate],
  preHandler: [logRequestBody],
  config: { rateLimit: { max: 300, timeWindow: '1 minute' } }
}, async (request, reply) => {
  // ── 1. Parse and validate request body ──────────────────────────────────────
  let d: ReturnType<typeof CreatePaymentBody.parse>;
  try {
    d = CreatePaymentBody.parse(request.body);
  } catch {
    return reply.code(400).send({ error: 'Invalid request payload' });
  }

  // ── 2. Read and validate optional Idempotency-Key header ────────────────────
  const idempotencyKey = readIdempotencyKey(request);

  if (idempotencyKey !== null && idempotencyKey.length > IDEMPOTENCY_KEY_MAX_LEN) {
    return reply.code(400).send({ error: 'Idempotency-Key must not exceed 255 characters' });
  }

  // ── 3. Idempotency check: look for a non-expired record with the same key ───
  if (idempotencyKey !== null) {
    const now = new Date();
    const existing = await prisma.payment.findFirst({
      where: {
        idempotencyKey,
        idempotencyKeyExpiresAt: { gt: now },
      },
    });

    if (existing) {
      request.log.info(
        { idempotencyKey, paymentId: existing.id },
        'Idempotency hit — returning cached payment'
      );
      return reply.code(200).send(existing);
    }
  }

  // ── 4. Create the payment (with idempotency fields when a key was supplied) ──
  const idempotencyKeyExpiresAt = idempotencyKey
    ? new Date(Date.now() + IDEMPOTENCY_TTL_MS)
    : null;

  try {
    const payment = await prisma.payment.create({
      data: {
        id: 'pay_' + crypto.randomUUID().replace(/-/g, ''),
        merchantId: d.merchantId,
        payerId: d.payerId,
        amount: d.amount,
        asset: d.asset,
        reference: d.reference,
        status: 'initiated',
        idempotencyKey: idempotencyKey ?? undefined,
        idempotencyKeyExpiresAt: idempotencyKeyExpiresAt ?? undefined,
      },
    });

    request.log.info(
      { idempotencyKey, paymentId: payment.id },
      idempotencyKey ? 'Idempotency miss — payment created' : 'Payment created (no idempotency key)'
    );

    return reply.code(201).send(payment);
  } catch (error) {
    return badRequest(reply, error);
  }
});

fastify.get<{ Params: PaymentParams }>('/api/payments/:id', async (request, reply) => {
  const { id } = request.params;
  const payment = await prisma.payment.findUnique({ where: { id } });
  if (!payment) return reply.code(404).send(createErrorResponse(ErrorCodes.NOT_FOUND, 'Payment not found'));
  return payment;
});

// Enforce valid status transitions. The DB enum and Prisma allow any status, so
// this route is the single place that guards the payment state machine.
fastify.patch<{ Params: PaymentParams; Body: UpdatePaymentStatusRouteBody }>('/api/payments/:id/status', {
  preValidation: [fastify.authenticate],
  preHandler: [logRequestBody],
  config: { rateLimit: { max: 300, timeWindow: '1 minute' } }
}, async (request, reply) => {
  let d: UpdatePaymentStatusBody;
  try {
    d = UpdatePaymentStatusBody.parse(request.body);
  } catch (error) {
    return badRequest(reply, error);
  }

  const { id } = request.params;
  const payment = await prisma.payment.findUnique({ where: { id } });
  if (!payment) return reply.code(404).send(createErrorResponse(ErrorCodes.NOT_FOUND, 'Payment not found'));

  const allowed = PAYMENT_STATUS_TRANSITIONS[payment.status] ?? [];
  if (!allowed.includes(d.status)) {
    return reply.code(422).send({
      error: 'Invalid status transition',
      from: payment.status,
      to: d.status,
    });
  }

  const updated = await prisma.payment.update({
    where: { id },
    data: { status: d.status },
  });
  return reply.send(updated);
});

// Settlements
fastify.get('/api/settlements', {
  preValidation: [fastify.authenticate],
  config: { rateLimit: { max: 100, timeWindow: '1 minute' } }
}, async (request, reply) => {
  const { merchantId, from, to } = request.query as { merchantId?: string; from?: string; to?: string };
  const where: any = {};
  if (merchantId) {
    where.merchantId = merchantId;
  }
  if (from || to) {
    where.initiatedAt = {};
    if (from) {
      where.initiatedAt.gte = new Date(from);
    }
    if (to) {
      where.initiatedAt.lte = new Date(to);
    }
  }

  const records = await prisma.settlement.findMany({
    where,
    orderBy: { initiatedAt: 'desc' },
  });
  return { settlements: records, total: records.length };
});

fastify.post<{ Body: CreateSettlementRouteBody }>('/api/settlements', {
  preValidation: [fastify.authenticate],
  preHandler: [logRequestBody],
  config: { rateLimit: { max: 30, timeWindow: '1 minute' } }
}, async (request, reply) => {
  try {
    const d = CreateSettlementBody.parse(request.body);
    const merchant = await prisma.merchant.findUnique({ where: { id: d.merchantId } });
    const settings = merchant?.settings as { webhookUrl?: string } | null | undefined;
    const webhookUrl = settings?.webhookUrl || null;

    const settlement = await prisma.settlement.create({
      data: {
        id: 'set_' + crypto.randomUUID().replace(/-/g, ''),
        merchantId: d.merchantId,
        totalAmount: d.amount,
        asset: d.asset,
        status: 'pending',
        webhookUrl,
      }
    });
    return reply.code(201).send(settlement);
  } catch (error) {
    return badRequest(reply, error);
  }
});

fastify.get('/api/deployments', async (request, reply) => {
  return {
    network: env.STELLAR_NETWORK_PASSPHRASE,
    contracts: [
      {
        name: 'Settlement contract',
        contractId: env.SETTLEMENT_CONTRACT_ID,
        explorerUrl: `https://lab.stellar.org/r/testnet/contract/${env.SETTLEMENT_CONTRACT_ID}`,
      },
      {
        name: 'Governance contract',
        contractId: env.GOVERNANCE_CONTRACT_ID,
        explorerUrl: `https://lab.stellar.org/r/testnet/contract/${env.GOVERNANCE_CONTRACT_ID}`,
      },
    ],
    updatedAt: new Date().toISOString(),
  };
});

// Graceful shutdown
let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;

  fastify.log.info(`Received ${signal}, shutting down gracefully...`);

  try {
    await fastify.close();
    await prisma.$disconnect();
    process.exit(0);
  } catch (err) {
    fastify.log.error(err, 'Error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

const start = async () => {
  try {
    // Seed admin merchant
    await prisma.merchant.upsert({
      where: { id: env.ADMIN_ADDRESS },
      update: {},
      create: {
        id: env.ADMIN_ADDRESS,
        name: 'BettaPay Merchant LLC',
        ownerId: 'admin-user-001',
        settings: { preferredAsset: 'USDC', autoSettle: true },
      }
    });

    await fastify.listen({ port: PORT, host: '0.0.0.0' });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};
start();
