import test from 'tape';
import Fastify from 'fastify';

// The configured body limit in src/index.ts (1MB = 1,048,576 bytes)
const BODY_LIMIT = 1_048_576;

function buildApp(limit: number = BODY_LIMIT) {
  const app = Fastify({
    logger: false,
    bodyLimit: limit,
  });

  app.post('/post', async (request) => {
    return { received: true, size: (request.body as string).length };
  });

  return app;
}

test('Fastify uses the configured request body size limits', async (t) => {
  const app = buildApp();
  t.equal(app.initialConfig.bodyLimit, 1_048_576, 'bodyLimit is configured to exactly 1,048,576 bytes (1MB)');
  await app.close();
  t.end();
});

test('payload below limit succeeds', async (t) => {
  const app = buildApp();

  // Create a payload that is 1KB below the limit (1,047,576 bytes)
  const size = BODY_LIMIT - 1000;
  const payload = 'a'.repeat(size);

  const response = await app.inject({
    method: 'POST',
    url: '/post',
    headers: {
      'content-type': 'text/plain',
    },
    payload,
  });

  t.equal(response.statusCode, 200, 'returns 200 OK for payload below limit');
  t.equal(JSON.parse(response.body).received, true, 'payload processed successfully');
  t.equal(JSON.parse(response.body).size, size, 'received correct size');

  await app.close();
  t.end();
});

test('payload exactly at limit succeeds', async (t) => {
  const app = buildApp();

  const payload = 'a'.repeat(BODY_LIMIT);

  const response = await app.inject({
    method: 'POST',
    url: '/post',
    headers: {
      'content-type': 'text/plain',
    },
    payload,
  });

  t.equal(response.statusCode, 200, 'returns 200 OK for payload exactly at limit');
  t.equal(JSON.parse(response.body).received, true, 'payload processed successfully');

  await app.close();
  t.end();
});

test('payload above limit is rejected with HTTP 413', async (t) => {
  const app = buildApp();

  // Create a payload 1 byte above the limit
  const payload = 'a'.repeat(BODY_LIMIT + 1);

  const response = await app.inject({
    method: 'POST',
    url: '/post',
    headers: {
      'content-type': 'text/plain',
    },
    payload,
  });

  t.equal(response.statusCode, 413, 'returns 413 Payload Too Large');
  
  const body = JSON.parse(response.body);
  t.equal(body.error, 'Payload Too Large', 'error name is Payload Too Large');
  t.equal(body.statusCode, 413, 'statusCode field is 413');

  await app.close();
  t.end();
});
