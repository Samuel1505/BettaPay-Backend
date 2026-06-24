import test from 'tape';
import Fastify, { type FastifyRequest } from 'fastify';
import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Self-contained idempotency tests for POST /api/payments.
//
// Mirrors the logic in src/index.ts but uses an in-memory store so no
// database is required (same pattern as payment-status.test.ts).
// ---------------------------------------------------------------------------

const IDEMPOTENCY_KEY_MAX_LEN = 255;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface FakePayment {
  id: string;
  merchantId: string;
  payerId?: string;
  amount: string;
  asset: string;
  status: string;
  reference?: string;
  createdAt: string;
  idempotencyKey?: string;
  idempotencyKeyExpiresAt?: Date;
}

// ---------------------------------------------------------------------------
// Builder — builds a lightweight Fastify app with the same idempotency logic
// as the real handler, backed by a shared in-memory store.
// ---------------------------------------------------------------------------

interface BuildOptions {
  /** Override the in-memory store (for concurrency / TTL tests). */
  store?: FakePayment[];
  /** If true, the next `create` call throws a P2002-like error. */
  injectP2002?: { once: boolean };
}

function buildApp(opts: BuildOptions = {}) {
  const store: FakePayment[] = opts.store ?? [];
  let throwP2002Once = opts.injectP2002?.once ?? false;

  const app = Fastify({ logger: false });

  function readIdempotencyKey(request: FastifyRequest): string | null {
    const raw = request.headers['idempotency-key'];
    if (!raw) return null;
    const key = Array.isArray(raw) ? raw[0] : raw;
    return (key as string).trim() || null;
  }

  app.post<{ Body: Record<string, unknown> }>('/api/payments', async (request, reply) => {
    // 1. Parse body
    const body = request.body;
    if (!body?.merchantId || !body?.amount || !body?.asset) {
      return reply.code(400).send({ error: 'Invalid request payload' });
    }

    // 2. Read + validate idempotency key
    const idempotencyKey = readIdempotencyKey(request);

    if (idempotencyKey !== null && idempotencyKey.length > IDEMPOTENCY_KEY_MAX_LEN) {
      return reply.code(400).send({ error: 'Idempotency-Key must not exceed 255 characters' });
    }

    // 3. Check for existing non-expired record
    if (idempotencyKey !== null) {
      const now = new Date();
      const existing = store.find(
        (p) =>
          p.idempotencyKey === idempotencyKey &&
          p.idempotencyKeyExpiresAt != null &&
          p.idempotencyKeyExpiresAt > now
      );
      if (existing) {
        return reply.code(200).send(existing);
      }
    }

    // 4. Create payment (simulate P2002 if requested)
    if (throwP2002Once) {
      throwP2002Once = false;
      // Simulate the race: the winning row was already inserted by the first request.
      // The P2002 handler must re-fetch it.
      const now = new Date();
      const existing = store.find(
        (p) =>
          p.idempotencyKey === idempotencyKey &&
          p.idempotencyKeyExpiresAt != null &&
          p.idempotencyKeyExpiresAt > now
      );
      if (existing) {
        return reply.code(200).send(existing);
      }
      return reply.code(400).send({ error: 'Invalid request payload' });
    }

    const payment: FakePayment = {
      id: 'pay_' + crypto.randomUUID().replace(/-/g, ''),
      merchantId: body.merchantId as string,
      payerId: body.payerId as string | undefined,
      amount: body.amount as string,
      asset: body.asset as string,
      status: 'initiated',
      reference: body.reference as string | undefined,
      createdAt: new Date().toISOString(),
      idempotencyKey: idempotencyKey ?? undefined,
      idempotencyKeyExpiresAt: idempotencyKey
        ? new Date(Date.now() + IDEMPOTENCY_TTL_MS)
        : undefined,
    };

    store.push(payment);
    return reply.code(201).send(payment);
  });

  return { app, store };
}

// Convenience POST helper
async function post(
  app: ReturnType<typeof buildApp>['app'],
  idempotencyKey?: string
) {
  return app.inject({
    method: 'POST',
    url: '/api/payments',
    headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {},
    payload: { merchantId: 'merch_1', amount: '10.00', asset: 'USDC' },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('1. First request without Idempotency-Key creates a payment (backward compat → 201)', async (t) => {
  const { app } = buildApp();
  const res = await post(app);

  t.equal(res.statusCode, 201, 'returns 201');
  const body = JSON.parse(res.body);
  t.ok(body.id, 'payment has an id');
  t.equal(body.status, 'initiated', 'status is initiated');
  t.notOk(body.idempotencyKey, 'no idempotencyKey stored');

  await app.close();
  t.end();
});

test('2. First request with Idempotency-Key creates a payment (201)', async (t) => {
  const { app } = buildApp();
  const key = crypto.randomUUID();
  const res = await post(app, key);

  t.equal(res.statusCode, 201, 'returns 201');
  const body = JSON.parse(res.body);
  t.equal(body.idempotencyKey, key, 'idempotencyKey is stored on the payment');

  await app.close();
  t.end();
});

test('3. Duplicate request with same Idempotency-Key returns existing payment (200)', async (t) => {
  const { app } = buildApp();
  const key = crypto.randomUUID();

  const first = await post(app, key);
  t.equal(first.statusCode, 201, 'first request is 201');
  const firstBody = JSON.parse(first.body);

  const second = await post(app, key);
  t.equal(second.statusCode, 200, 'second request is 200');
  const secondBody = JSON.parse(second.body);

  t.equal(secondBody.id, firstBody.id, 'returns the original payment id');
  t.equal(secondBody.idempotencyKey, firstBody.idempotencyKey, 'same idempotency key');

  await app.close();
  t.end();
});

test('4. Requests without Idempotency-Key always create new payments (backward compat)', async (t) => {
  const { app, store } = buildApp();

  const r1 = await post(app);
  const r2 = await post(app);

  t.equal(r1.statusCode, 201, 'first is 201');
  t.equal(r2.statusCode, 201, 'second is 201');
  t.equal(store.length, 2, 'two separate payments created');
  t.notEqual(JSON.parse(r1.body).id, JSON.parse(r2.body).id, 'different ids');

  await app.close();
  t.end();
});

test('5. Concurrent duplicate requests — P2002 race path returns 200 with existing payment', async (t) => {
  // Seed the store with the "winning" row so the re-fetch finds it.
  const key = crypto.randomUUID();
  const winnerPayment: FakePayment = {
    id: 'pay_winner',
    merchantId: 'merch_1',
    amount: '10.00',
    asset: 'USDC',
    status: 'initiated',
    createdAt: new Date().toISOString(),
    idempotencyKey: key,
    idempotencyKeyExpiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
  };

  const { app } = buildApp({
    store: [winnerPayment],
    injectP2002: { once: true }, // forces the P2002 path on next create
  });

  // This request arrives after the winning row was inserted; the P2002 handler
  // should re-fetch and return the winner with 200.
  const res = await post(app, key);

  t.equal(res.statusCode, 200, 'race-loser returns 200');
  const body = JSON.parse(res.body);
  t.equal(body.id, 'pay_winner', 'returns the winning payment');

  await app.close();
  t.end();
});

test('6. TTL expiration — expired key is treated as absent, new payment is created (201)', async (t) => {
  const key = crypto.randomUUID();
  // Insert an already-expired record.
  const expired: FakePayment = {
    id: 'pay_old',
    merchantId: 'merch_1',
    amount: '10.00',
    asset: 'USDC',
    status: 'initiated',
    createdAt: new Date().toISOString(),
    idempotencyKey: key,
    idempotencyKeyExpiresAt: new Date(Date.now() - 1), // already expired
  };

  const { app, store } = buildApp({ store: [expired] });
  const res = await post(app, key);

  t.equal(res.statusCode, 201, 'returns 201 — expired key treated as absent');
  const body = JSON.parse(res.body);
  t.notEqual(body.id, 'pay_old', 'a new payment was created');
  t.equal(store.length, 2, 'new record was appended to the store');

  await app.close();
  t.end();
});

test('7. Idempotency-Key exceeding 255 characters is rejected (400)', async (t) => {
  const { app } = buildApp();
  const longKey = 'a'.repeat(256);

  const res = await app.inject({
    method: 'POST',
    url: '/api/payments',
    headers: { 'idempotency-key': longKey },
    payload: { merchantId: 'merch_1', amount: '10.00', asset: 'USDC' },
  });

  t.equal(res.statusCode, 400, 'returns 400 for oversized key');
  t.ok(JSON.parse(res.body).error.includes('255'), 'error message mentions the limit');

  await app.close();
  t.end();
});

test('8. Original response payload is fully preserved on idempotent replay', async (t) => {
  const { app } = buildApp();
  const key = crypto.randomUUID();

  const first = await post(app, key);
  const original = JSON.parse(first.body);

  const second = await post(app, key);
  const replayed = JSON.parse(second.body);

  // Every field that was in the original must match exactly.
  t.equal(replayed.id,           original.id,           'id matches');
  t.equal(replayed.merchantId,   original.merchantId,   'merchantId matches');
  t.equal(replayed.amount,       original.amount,       'amount matches');
  t.equal(replayed.asset,        original.asset,        'asset matches');
  t.equal(replayed.status,       original.status,       'status matches');
  t.equal(replayed.createdAt,    original.createdAt,    'createdAt matches');
  t.equal(replayed.idempotencyKey, original.idempotencyKey, 'idempotencyKey matches');

  await app.close();
  t.end();
});
