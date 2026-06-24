import test from 'tape';
import Fastify from 'fastify';
import { z } from 'zod';
import { createErrorResponse, ErrorCodes } from '@bettapay/validation';

// Mirrors the badRequest helper in src/index.ts.
function badRequest(reply: any, error: unknown) {
  if (error instanceof z.ZodError) {
    return reply.code(400).send(createErrorResponse(ErrorCodes.VALIDATION_ERROR, 'Validation failed', error.errors));
  }
  return reply.code(400).send(createErrorResponse(ErrorCodes.INVALID_REQUEST, 'Invalid request payload'));
}

test('createErrorResponse builds the standard envelope', (t) => {
  const res = createErrorResponse(ErrorCodes.NOT_FOUND, 'Merchant not found');
  t.deepEqual(res, { error: { code: 'NOT_FOUND', message: 'Merchant not found' } }, 'shape is { error: { code, message } }');
  t.notOk('details' in res.error, 'details is omitted when not provided');
  t.end();
});

test('createErrorResponse includes details when provided', (t) => {
  const res = createErrorResponse(ErrorCodes.VALIDATION_ERROR, 'Validation failed', [{ path: ['amount'] }]);
  t.equal(res.error.code, 'VALIDATION_ERROR', 'code is set');
  t.ok(Array.isArray(res.error.details), 'details is carried through');
  t.end();
});

test('a Zod failure returns a 400 VALIDATION_ERROR with the issue list in details', async (t) => {
  const app = Fastify({ logger: false });
  const Body = z.object({ amount: z.string().regex(/^\d+$/, 'amount must be numeric') });

  app.post('/x', async (request, reply) => {
    try {
      Body.parse(request.body);
      return reply.send({ ok: true });
    } catch (error) {
      return badRequest(reply, error);
    }
  });

  const res = await app.inject({ method: 'POST', url: '/x', payload: { amount: 'not-a-number' } });
  t.equal(res.statusCode, 400, 'status is preserved at 400');
  const body = JSON.parse(res.body);
  t.equal(body.error.code, 'VALIDATION_ERROR', 'code is VALIDATION_ERROR');
  t.ok(Array.isArray(body.error.details) && body.error.details.length > 0, 'details holds the Zod error list');

  await app.close();
  t.end();
});
