import { z } from 'zod';
import { IncomingMessage } from 'http';
import { randomUUID } from 'crypto';

export * from './schemas.js';
export * from './plugins.js';
import "dotenv/config";

export function genReqId(req: IncomingMessage): string {
  return (req.headers['x-request-id'] as string) || randomUUID();
}

// ─── Standard error response envelope ─────────────────────────────────────────
// Every API error response follows { error: { code, message, details? } } so
// clients can branch on a stable `code` instead of parsing human-readable strings.

export const ErrorCodes = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_REQUEST: 'INVALID_REQUEST',
  REQUEST_TIMEOUT: 'REQUEST_TIMEOUT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  UNSUPPORTED_CURRENCY_PAIR: 'UNSUPPORTED_CURRENCY_PAIR',
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  INVALID_QUERY: 'INVALID_QUERY',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export function createErrorResponse(code: string, message: string, details?: unknown): ErrorResponse {
  const error: ErrorResponse['error'] = { code, message };
  if (details !== undefined) {
    error.details = details;
  }
  return { error };
}

// Backend environment schema — all critical values are required.
// Services will refuse to start if any required variable is missing.
export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().transform((s) => parseInt(s, 10)).default('3000'),

  // Fees — default basis points applied when a merchant has no custom fee rule.
  FEES_DEFAULT_BPS: z.string().transform((s) => parseInt(s, 10)).default('100'),

  // Auth
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('24h'),

  // CORS — comma-separated origins
  ALLOWED_ORIGINS: z.string().default('http://localhost:3000'),

  // Database — required; services crash fast if not provided
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // Redis — optional, falls back to localhost
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // Stellar
  STELLAR_RPC_URL: z.string().url().default('https://soroban-testnet.stellar.org'),
  STELLAR_NETWORK_PASSPHRASE: z.string().default('Test SDF Network ; September 2015'),
  STELLAR_HORIZON_URL: z.string().url().default('https://horizon-testnet.stellar.org'),

  // Contract addresses — required; no silent fallbacks in code
  SETTLEMENT_CONTRACT_ID: z.string().min(1, 'SETTLEMENT_CONTRACT_ID is required'),
  GOVERNANCE_CONTRACT_ID: z.string().min(1, 'GOVERNANCE_CONTRACT_ID is required'),
  ADMIN_ADDRESS: z.string().min(1, 'ADMIN_ADDRESS is required'),

  // Service URLs (used by gateway to proxy requests)
  FX_ENGINE_URL: z.string().url().default('http://localhost:3002'),
  SETTLEMENT_ENGINE_URL: z.string().url().default('http://localhost:3001'),
  INDEXER_URL: z.string().url().default('http://localhost:3003'),

  // FX Engine — live rate fetching and caching
  RATES_API_URL: z.string().url().default(
    'https://api.coingecko.com/api/v3/simple/price?ids=usd-coin,tether-eurt&vs_currencies=ngn'
  ),
  RATES_REFRESH_INTERVAL_MS: z.string().transform((s) => parseInt(s, 10)).default('60000'),
  RATES_CACHE_TTL_MS: z.string().transform((s) => parseInt(s, 10)).default('60000'),
});

export type Env = z.infer<typeof EnvSchema>;

export function validateEnv(env: Record<string, unknown>): Env {
  try {
    return EnvSchema.parse(env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const message = error.errors.map((e) => `  ${e.path.join('.')}: ${e.message}`).join('\n');
      throw new Error(`\n[BettaPay] Invalid or missing environment variables:\n${message}\n`);
    }
    throw error;
  }
}
