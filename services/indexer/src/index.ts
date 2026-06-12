/**
 * Indexer Service — BettaPay Backend
 *
 * Listens to Soroban contract event streams and indexes payment/settlement events.
 * In production, this polls the Stellar RPC for contract events.
 *
 * Endpoints:
 *   GET /api/events              — list indexed events (newest first, max 50)
 *   GET /api/health              — liveness probe
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { validateEnv } from '@bettapay/validation';

const env = validateEnv(process.env);
const PORT = Number(process.env.PORT ?? '3003');

const SETTLEMENT_CONTRACT_ID =
  process.env.SETTLEMENT_CONTRACT_ID ?? 'CBGBGKJSUY7XYB6HWW4CVAU6MW2KD25FSF45E5KCP53TKUK374MBZNFB';

const GOVERNANCE_CONTRACT_ID =
  process.env.GOVERNANCE_CONTRACT_ID ?? 'CDPFWUTIXF5BC6BKNDLSQOZSDQCXAJNZFCZWHBE2RRHANRN25T3ILPZ7';

const fastify = Fastify({ logger: true });
fastify.register(cors, { origin: '*' });

// In-memory event ring buffer (50 events max)
const events: any[] = [];

function pushEvent(topic: string, contractId: string, data: Record<string, unknown>) {
  const event = {
    id: 'evt_' + Math.random().toString(36).slice(2, 15),
    contractId,
    topic,
    ...data,
    indexedAt: new Date().toISOString(),
  };
  events.unshift(event);
  if (events.length > 50) events.pop();
  fastify.log.info(`[Indexer] ${topic} — ${event.id}`);
  return event;
}

// HTTP API
fastify.get('/api/health', async (request, reply) => {
  return { status: 'ok', indexedEvents: events.length };
});

fastify.get('/api/events', async (request, reply) => {
  return { events, total: events.length };
});

// Simulate polling Stellar RPC for contract events
const TOPICS = ['payment', 'split', 'set_rule', 'merchant', 'fee_cfg', 'anchor_up'];

setInterval(() => {
  if (Math.random() > 0.65) {
    const topic = TOPICS[Math.floor(Math.random() * TOPICS.length)];
    const isGovernance = topic === 'fee_cfg' || topic === 'anchor_up';
    pushEvent(topic, isGovernance ? GOVERNANCE_CONTRACT_ID : SETTLEMENT_CONTRACT_ID, {
      merchant: 'GCCHHKNI7GRA5QWC7RCTT3OHO7SKAUMKQA6IBWEQEO2SXI3GF376UHDD',
      amount: (Math.random() * 500 + 10).toFixed(2),
      asset: 'USDC',
    });
  }
}, 10_000);

const start = async () => {
  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};
start();
