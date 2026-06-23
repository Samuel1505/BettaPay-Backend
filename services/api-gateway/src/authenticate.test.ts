import test from 'tape';
import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { FastifyRequest, FastifyReply } from 'fastify';

test('authenticate decorator should return generic 401 on invalid JWT', async (t) => {
  const fastify = Fastify({ logger: false });

  fastify.register(fastifyJwt, {
    secret: 'test-secret-key',
    sign: { expiresIn: '24h' }
  });

  // Decorate with fixed authenticate function
  fastify.decorate('authenticate', async function (request: FastifyRequest, reply: FastifyReply) {
    try {
      await request.jwtVerify();
    } catch (err) {
      request.log.error(err);
      reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  fastify.post('/test', { preValidation: [fastify.authenticate] }, async (request, reply) => {
    return { success: true };
  });

  try {
    // Test 1: Invalid JWT token should return 401 with generic message
    const response1 = await fastify.inject({
      method: 'POST',
      url: '/test',
      headers: { authorization: 'Bearer invalid_token' }
    });

    t.equal(response1.statusCode, 401, 'Status code should be 401');
    const body1 = JSON.parse(response1.body);
    t.equal(body1.error, 'Unauthorized', 'Error message should be generic "Unauthorized"');
    t.notOk(response1.body.includes('fast-jwt'), 'Response should not contain fast-jwt error details');
    t.notOk(response1.body.includes('ERR_'), 'Response should not contain error codes');

    // Test 2: Missing authorization header should return 401
    const response2 = await fastify.inject({
      method: 'POST',
      url: '/test'
    });

    t.equal(response2.statusCode, 401, 'Status code should be 401 for missing auth');
    const body2 = JSON.parse(response2.body);
    t.equal(body2.error, 'Unauthorized', 'Error message should be generic "Unauthorized" for missing auth');
    t.notOk(response2.body.includes('Missing'), 'Response should not contain "Missing" error text');

    // Test 3: Valid JWT token should pass through
    const token = fastify.jwt.sign({ userId: 'test-user' });
    const response3 = await fastify.inject({
      method: 'POST',
      url: '/test',
      headers: { authorization: `Bearer ${token}` }
    });

    t.equal(response3.statusCode, 200, 'Valid JWT should pass authentication');

    await fastify.close();
    t.end();
  } catch (err) {
    t.fail(err);
    await fastify.close();
    t.end();
  }
});
