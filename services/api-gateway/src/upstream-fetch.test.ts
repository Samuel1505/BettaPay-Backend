import test from 'tape';
import Fastify from 'fastify';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  DOWNSTREAM_DEADLINE_RATIO,
  UpstreamTimeoutError,
  createDownstreamAbortSignal,
  fetchUpstream,
  getDownstreamDeadlineMs,
  getRequestTimeoutMs,
} from './upstream-fetch.js';

function buildRequest(headers: Record<string, string> = {}, startTime = Date.now()) {
  return {
    headers,
    __startTime: startTime,
  } as any;
}

test('getRequestTimeoutMs reads Request-Timeout header', (t) => {
  t.equal(getRequestTimeoutMs(buildRequest()), DEFAULT_REQUEST_TIMEOUT_MS);
  t.equal(getRequestTimeoutMs(buildRequest({ 'request-timeout': '5000' })), 5000);
  t.equal(getRequestTimeoutMs(buildRequest({ 'request-timeout': 'invalid' })), DEFAULT_REQUEST_TIMEOUT_MS);
  t.end();
});

test('getDownstreamDeadlineMs uses 80% of remaining time', (t) => {
  const startTime = Date.now() - 10_000;
  const deadline = getDownstreamDeadlineMs(buildRequest({ 'request-timeout': '20000' }, startTime));
  const expected = Math.floor((20_000 - 10_000) * DOWNSTREAM_DEADLINE_RATIO);
  t.equal(deadline, expected);
  t.end();
});

test('createDownstreamAbortSignal aborts immediately when deadline is exhausted', (t) => {
  const app = Fastify({ logger: false });
  const request = buildRequest({ 'request-timeout': '1000' }, Date.now() - 2000);
  const { signal } = createDownstreamAbortSignal(request, app.log, 'http://example.test/upstream');
  t.ok(signal.aborted, 'signal is aborted when no time remains');
  app.close();
  t.end();
});

test('fetchUpstream throws UpstreamTimeoutError on abort', async (t) => {
  const app = Fastify({ logger: false });
  const request = buildRequest({ 'request-timeout': '1000' }, Date.now() - 5000);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    const signal = init?.signal;
    if (signal?.aborted) {
      throw new DOMException('The operation was aborted', 'AbortError');
    }

    await new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted', 'AbortError'));
      });
    });

    return new Response('{}');
  }) as typeof fetch;

  try {
    await fetchUpstream(request, 'http://example.test/slow', {}, app.log);
    t.fail('expected timeout error');
  } catch (err) {
    t.ok(err instanceof UpstreamTimeoutError, 'throws UpstreamTimeoutError');
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
    t.end();
  }
});
