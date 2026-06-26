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
import { validateEnv, registerErrorHandler, PaginationQuery } from '@bettapay/validation';

const env = validateEnv(process.env);
const PORT = Number(process.env.PORT ?? '3003');

const fastify = Fastify({ logger: true });

fastify.register(cors, { 
  origin: env.ALLOWED_ORIGINS
});
registerErrorHandler(fastify);

// In-memory event ring buffer (50 events max)
const events: any[] = [];
let latestLedgerCursor: number | undefined = undefined;

function pushEvent(topic: string, contractId: string, data: Record<string, unknown>, ledger: number) {
  const event = {
    id: 'evt_' + crypto.randomUUID().replace(/-/g, ''),
    contractId,
    topic,
    ...data,
    ledger,
    indexedAt: new Date().toISOString(),
  };
  events.unshift(event);
  if (events.length > 50) events.pop();
  fastify.log.info(`[Indexer] ${topic} — ${event.id} (Ledger ${ledger})`);
  return event;
}

// HTTP API
fastify.get('/api/health', async (request, reply) => {
  return { status: 'ok', indexedEvents: events.length, latestLedgerCursor };
});

fastify.get('/api/events', async (request, reply) => {
  const { limit, offset } = PaginationQuery.parse(request.query ?? {});
  const paginatedEvents = events.slice(offset, offset + limit);
  return { events: paginatedEvents, total: events.length, latestLedgerCursor };
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
        // Simple mapping of topics for this demo.
        // In production, decode XDR values properly.
        pushEvent(
          evt.topic.join(','),
          evt.contractId ? evt.contractId.toString() : 'unknown',
          { rawValue: evt.value.toXDR('base64') },
          evt.ledger
        );
        latestLedgerCursor = Math.max(latestLedgerCursor, evt.ledger + 1);
      }
    } else {
      // If no events, just advance cursor by querying latest ledger
      const latest = await server.getLatestLedger();
      latestLedgerCursor = Math.max(latestLedgerCursor, latest.sequence);
    }
  } catch (err) {
    fastify.log.error(`[Indexer] Polling error: ${err}`);
  } finally {
    setTimeout(pollEvents, 5000);
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
