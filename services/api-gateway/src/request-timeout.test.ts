import test from 'tape';
import Fastify from 'fastify';

// These mirror the request-timeout configuration in src/index.ts. The test stays
// self-contained (like authenticate.test.ts) so it does not boot the real server.
const REQUEST_TIMEOUT_MS = 30_000;
const CONNECTION_TIMEOUT_MS = 31_000;

// Builds an app with the same timeout config and per-request 408 hook as the gateway.
// `handlerTimeoutMs` is parameterised so the slow-handler test can run quickly.
function buildApp(handlerTimeoutMs: number) {
  const app = Fastify({
    logger: false,
    requestTimeout: REQUEST_TIMEOUT_MS,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
  });

  app.addHook('onRequest', async (request, reply) => {
    const timeoutTimer = setTimeout(() => {
      if (!reply.sent) {
        reply.code(408).send({ error: 'Request Timeout' });
      }
    }, handlerTimeoutMs);
    (request as any).__timeoutTimer = timeoutTimer;
  });

  app.addHook('onResponse', async (request) => {
    const timeoutTimer = (request as any).__timeoutTimer;
    if (timeoutTimer) clearTimeout(timeoutTimer);
  });

  // Sleeps far longer than the timeout to verify the 408 path.
  app.get('/slow', async () => {
    await new Promise((resolve) => setTimeout(resolve, handlerTimeoutMs * 4));
    return { ok: true };
  });

  app.get('/fast', async () => ({ ok: true }));

  return app;
}

test('Fastify uses the documented request and connection timeouts', async (t) => {
  const app = buildApp(REQUEST_TIMEOUT_MS);
  t.equal(app.initialConfig.requestTimeout, 30_000, 'requestTimeout is 30s');
  t.equal(app.initialConfig.connectionTimeout, 31_000, 'connectionTimeout is 31s (1s above requestTimeout)');
  await app.close();
  t.end();
});

test('a request that exceeds the timeout returns 408', async (t) => {
  // Short timeout so the test is fast.
  const app = buildApp(150);

  const slow = await app.inject({ method: 'GET', url: '/slow' });
  t.equal(slow.statusCode, 408, 'slow handler returns 408 Request Timeout');
  t.equal(JSON.parse(slow.body).error, 'Request Timeout', 'body reports Request Timeout');

  const fast = await app.inject({ method: 'GET', url: '/fast' });
  t.equal(fast.statusCode, 200, 'a fast handler still returns 200');

  await app.close();
  t.end();
});
