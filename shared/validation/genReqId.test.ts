import test from 'node:test';
import assert from 'node:assert';
import { genReqId } from './index.js';
import { FastifyRequest } from 'fastify';
import { IncomingMessage } from 'http';

test('genReqId - header present returns supplied request ID', () => {
  const req = {
    headers: {
      'x-request-id': 'custom-id-123'
    }
  } as unknown as FastifyRequest;

  const result = genReqId(req);
  assert.strictEqual(result, 'custom-id-123');
  
  const rawReq = {
    headers: {
      'x-request-id': 'raw-id-456'
    }
  } as unknown as IncomingMessage;

  const rawResult = genReqId(rawReq);
  assert.strictEqual(rawResult, 'raw-id-456');
});

test('genReqId - missing header falls back to crypto.randomUUID()', () => {
  const req = {
    headers: {}
  } as unknown as FastifyRequest;

  const result = genReqId(req);
  // Verify it is a valid UUID
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  assert.match(result, uuidRegex);
  
  const rawReq = {
    headers: {}
  } as unknown as IncomingMessage;

  const rawResult = genReqId(rawReq);
  assert.match(rawResult, uuidRegex);
});
