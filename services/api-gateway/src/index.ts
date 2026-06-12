/**
 * API Gateway — BettaPay Backend
 *
 * Unified REST entry point for the BettaPay platform.
 * Handles merchant registration, payment sessions, and settlement requests.
 *
 * Endpoints:
 *   GET  /api/health               — liveness probe
 *   POST /api/merchants            — register merchant
 *   GET  /api/merchants/:id        — fetch merchant
 *   POST /api/payments             — initiate payment session
 *   GET  /api/payments/:id         — fetch payment session
 *   POST /api/settlements          — trigger settlement
 *   GET  /api/deployments          — Soroban contract addresses (testnet)
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { validateEnv } from '@bettapay/validation';
import { PrismaClient } from '@prisma/client';

const env = validateEnv(process.env);
const PORT = Number(process.env.PORT ?? '3000');

const fastify = Fastify({ logger: true });
const prisma = new PrismaClient();

// Setup plugins
fastify.register(cors, { origin: '*' });

function uid(prefix: string) {
  return prefix + '_' + Math.random().toString(36).slice(2, 15);
}

// Routes
fastify.get('/api/health', async (request, reply) => {
  return { status: 'healthy', env: env.NODE_ENV };
});

// Merchants
fastify.post('/api/merchants', async (request, reply) => {
  const d = request.body as any;
  if (!d.id || !d.name) return reply.code(400).send({ error: 'id and name required' });
  const merchant = await prisma.merchant.create({
    data: {
      id: d.id,
      name: d.name,
      ownerId: d.ownerId || 'unknown',
      settings: d.settings || {},
    }
  });
  return reply.code(201).send({ success: true, merchant });
});

fastify.get('/api/merchants/:id', async (request, reply) => {
  const { id } = request.params as any;
  const merchant = await prisma.merchant.findUnique({ where: { id } });
  if (!merchant) return reply.code(404).send({ error: 'Merchant not found' });
  return merchant;
});

// Payments
fastify.post('/api/payments', async (request, reply) => {
  const d = request.body as any;
  if (!d.merchantId || !d.amount || !d.asset)
    return reply.code(400).send({ error: 'merchantId, amount, asset required' });
  
  const payment = await prisma.payment.create({
    data: {
      id: uid('pay'),
      merchantId: d.merchantId,
      payerId: d.payerId,
      amount: String(d.amount),
      asset: d.asset,
      status: 'initiated',
    }
  });
  return reply.code(201).send(payment);
});

fastify.get('/api/payments/:id', async (request, reply) => {
  const { id } = request.params as any;
  const payment = await prisma.payment.findUnique({ where: { id } });
  if (!payment) return reply.code(404).send({ error: 'Payment not found' });
  return payment;
});

// Settlements
fastify.post('/api/settlements', async (request, reply) => {
  const d = request.body as any;
  if (!d.merchantId || !d.amount || !d.asset)
    return reply.code(400).send({ error: 'merchantId, amount, asset required' });
  
  const settlement = await prisma.settlement.create({
    data: {
      id: uid('set'),
      merchantId: d.merchantId,
      totalAmount: String(d.amount),
      asset: d.asset,
      status: 'pending',
    }
  });
  return reply.code(201).send(settlement);
});

fastify.get('/api/deployments', async (request, reply) => {
  return {
    network: 'Test SDF Network ; September 2015',
    adminAddress: process.env.ADMIN_ADDRESS || 'GCCHHKNI7GRA5QWC7RCTT3OHO7SKAUMKQA6IBWEQEO2SXI3GF376UHDD',
    contracts: [
      {
        name: 'Settlement contract',
        contractId: process.env.SETTLEMENT_CONTRACT_ID ?? 'CBGBGKJSUY7XYB6HWW4CVAU6MW2KD25FSF45E5KCP53TKUK374MBZNFB',
        explorerUrl: 'https://lab.stellar.org/r/testnet/contract/CBGBGKJSUY7XYB6HWW4CVAU6MW2KD25FSF45E5KCP53TKUK374MBZNFB',
      },
      {
        name: 'Governance contract',
        contractId: process.env.GOVERNANCE_CONTRACT_ID ?? 'CDPFWUTIXF5BC6BKNDLSQOZSDQCXAJNZFCZWHBE2RRHANRN25T3ILPZ7',
        explorerUrl: 'https://lab.stellar.org/r/testnet/contract/CDPFWUTIXF5BC6BKNDLSQOZSDQCXAJNZFCZWHBE2RRHANRN25T3ILPZ7',
      },
    ],
    updatedAt: new Date().toISOString(),
  };
});

const start = async () => {
  try {
    // Seed admin merchant
    await prisma.merchant.upsert({
      where: { id: 'GCCHHKNI7GRA5QWC7RCTT3OHO7SKAUMKQA6IBWEQEO2SXI3GF376UHDD' },
      update: {},
      create: {
        id: 'GCCHHKNI7GRA5QWC7RCTT3OHO7SKAUMKQA6IBWEQEO2SXI3GF376UHDD',
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
