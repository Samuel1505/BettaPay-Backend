/**
 * FX Engine — BettaPay Backend
 *
 * Provides exchange rate quotes for currency pairs.
 * Rates are fetched from an external API at a configurable interval and
 * cached in memory with a TTL. Hardcoded defaults serve as fallback.
 *
 * Endpoints:
 *   GET /api/rates               — latest cached rates with cache metadata
 *   GET /api/currencies          — list of supported currency codes
 *   GET /api/quote?from=&to=&amount= — FX quote
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import {
  validateEnv,
  registerErrorHandler,
  createErrorResponse,
  ErrorCodes,
  genReqId,
} from '@bettapay/validation';

const env = validateEnv(process.env);
const PORT = Number(process.env.PORT ?? '3002');
const startTime = Date.now();

// ── Fallback / seed rates (issue #47) ──────────────────────────────────────
// Used on first startup before the external API responds, and whenever the
// API is unreachable so the service degrades gracefully.

const FALLBACK_RATES: Record<string, number> = {
  USDC: 1545.50,
  EURT: 1680.20,
  NGN:  1.0,
};

const CURRENCY_DISPLAY_NAMES: Record<string, string> = {
  USDC: 'USD Coin',
  EURT: 'Euro Tether',
  NGN:  'Nigerian Naira',
};

const SUPPORTED_CURRENCIES = Object.keys(FALLBACK_RATES);

// ── In-memory rate cache (issues #47 & #48) ────────────────────────────────

interface RateCache {
  rates: Record<string, number>;
  cachedAt: number; // Unix ms timestamp
}

let cache: RateCache = {
  rates:    { ...FALLBACK_RATES },
  cachedAt: Date.now(),
};

const fastify = Fastify({
  logger: true,
  genReqId,
});

fastify.register(cors, {
  origin: env.ALLOWED_ORIGINS,
});
fastify.register(rateLimit, { max: 200, timeWindow: 60 * 1000 });
registerErrorHandler(fastify);

fastify.get('/api/health', async (_request, _reply) => {
  return {
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
  };
});

fastify.get('/api/rates', async (_request, _reply) => {
  return { rates: cache.rates, updatedAt: new Date(cache.cachedAt).toISOString() };
});

fastify.get('/api/currencies', async (_request, _reply) => {
  return {
    currencies: SUPPORTED_CURRENCIES.map((code) => ({
      code,
      name: CURRENCY_DISPLAY_NAMES[code],
    })),
  };
});

// ── GET /api/quote (issues #48 & #49) ────────────────────────────────────

const QuoteQuerySchema = z.object({
  from:   z.string().default('USDC'),
  to:     z.string().default('NGN'),
  amount: z.string().regex(/^\d+(\.\d+)?$/, 'amount must be a numeric string').default('1'),
});

fastify.get(
  '/api/quote',
  {
    config: {
      rateLimit: {
        max:        100,
        timeWindow: 60 * 1000,
      },
    },
  },
  async (request, reply) => {
    let query: z.infer<typeof QuoteQuerySchema>;
    try {
      query = QuoteQuerySchema.parse(request.query);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply.code(400).send(
          createErrorResponse(ErrorCodes.INVALID_QUERY, 'Invalid query parameters', err.errors),
        );
      }
      throw err;
    }

    const from   = query.from.toUpperCase();
    const to     = query.to.toUpperCase();
    const amount = parseFloat(query.amount);

    if (amount <= 0) {
      return reply.code(400).send(
        createErrorResponse(ErrorCodes.INVALID_AMOUNT, 'Amount must be greater than zero'),
      );
    }

    // Validate that both currencies are supported (issue #49)
    const unsupported: string[] = [];
    if (!SUPPORTED_CURRENCIES.includes(from)) unsupported.push(from);
    if (!SUPPORTED_CURRENCIES.includes(to))   unsupported.push(to);

    if (unsupported.length > 0) {
      return reply.code(400).send(
        createErrorResponse(
          ErrorCodes.UNSUPPORTED_CURRENCY_PAIR,
          `Unsupported currency: ${unsupported.join(', ')}`,
          { unsupportedCurrencies: unsupported, supportedCurrencies: SUPPORTED_CURRENCIES },
        ),
      );
    }

    if (from === to) {
      return reply.code(400).send(
        createErrorResponse(ErrorCodes.INVALID_QUERY, 'from and to must be different currencies'),
      );
    }

    const rates = cache.rates;
    const amountInNgn  = amount * rates[from];
    const targetAmount = amountInNgn / rates[to];
    const exchangeRate = rates[from] / rates[to];

    return {
      from,
      to,
      amount:        amount.toString(),
      result:        targetAmount.toFixed(4),
      rate:          exchangeRate.toFixed(4),
      slippageLimit: '0.005',
      cachedAt:      new Date(cache.cachedAt).toISOString(),
      expiresAt:     new Date(Date.now() + 60_000).toISOString(),
    };
  },
);

// ── Start ──────────────────────────────────────────────────────────────────

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;

  fastify.log.info(`Received ${signal}, shutting down gracefully...`);

  try {
    await fastify.close();
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
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};
start();
