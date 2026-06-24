import test from 'tape';
import Fastify from 'fastify';
import { UpdateMerchantSettingsBody } from '@bettapay/validation';

// Mirrors PATCH /api/merchants/:id/settings from src/index.ts, backed by an
// in-memory merchant so the test does not need a database.
function buildApp(initial: Record<string, unknown> | 'missing') {
  const app = Fastify({ logger: false });
  const merchant = initial === 'missing' ? null : { id: 'm1', settings: initial as Record<string, unknown> };

  app.patch<{ Params: { id: string }; Body: unknown }>('/api/merchants/:id/settings', async (request, reply) => {
    let d;
    try {
      d = UpdateMerchantSettingsBody.parse(request.body);
    } catch {
      return reply.code(400).send({ error: 'Invalid request payload' });
    }
    if (!merchant) return reply.code(404).send({ error: 'Merchant not found' });
    merchant.settings = { ...(merchant.settings ?? {}), ...d };
    return reply.code(200).send({ success: true, merchant });
  });

  return app;
}

async function patch(app: ReturnType<typeof buildApp>, payload: unknown) {
  return app.inject({ method: 'PATCH', url: '/api/merchants/m1/settings', payload });
}

test('updating feeBps merges into existing settings', async (t) => {
  const app = buildApp({ tier: 'silver', autoSettle: true });
  const res = await patch(app, { feeBps: 75 });
  t.equal(res.statusCode, 200, 'returns 200');
  const settings = JSON.parse(res.body).merchant.settings;
  t.equal(settings.feeBps, 75, 'feeBps is set');
  t.equal(settings.autoSettle, true, 'unrelated settings are preserved');
  await app.close();
  t.end();
});

test('updating a missing merchant returns 404', async (t) => {
  const app = buildApp('missing');
  const res = await patch(app, { feeBps: 75 });
  t.equal(res.statusCode, 404, 'returns 404');
  await app.close();
  t.end();
});

test('an out-of-range feeBps is rejected', async (t) => {
  const app = buildApp({});
  const res = await patch(app, { feeBps: 20000 });
  t.equal(res.statusCode, 400, 'returns 400 for feeBps above 10000');
  await app.close();
  t.end();
});
