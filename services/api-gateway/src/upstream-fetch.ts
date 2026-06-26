import type { FastifyBaseLogger, FastifyRequest } from 'fastify';

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DOWNSTREAM_DEADLINE_RATIO = 0.8;

export class UpstreamTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamTimeoutError';
  }
}

export function getRequestStartTime(request: FastifyRequest): number {
  return (request as FastifyRequest & { __startTime?: number }).__startTime ?? Date.now();
}

export function getRequestTimeoutMs(request: FastifyRequest, defaultTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): number {
  const header = request.headers['request-timeout'];
  if (!header) return defaultTimeoutMs;

  const raw = Array.isArray(header) ? header[0] : header;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultTimeoutMs;
  return parsed;
}

export function getDownstreamDeadlineMs(
  request: FastifyRequest,
  defaultTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
): number {
  const startTime = getRequestStartTime(request);
  const totalTimeout = getRequestTimeoutMs(request, defaultTimeoutMs);
  const elapsed = Date.now() - startTime;
  const remaining = Math.max(0, totalTimeout - elapsed);
  return Math.floor(remaining * DOWNSTREAM_DEADLINE_RATIO);
}

export function createDownstreamAbortSignal(
  request: FastifyRequest,
  logger: FastifyBaseLogger,
  targetUrl: string,
  defaultTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
): { signal: AbortSignal; cleanup: () => void } {
  const deadlineMs = getDownstreamDeadlineMs(request, defaultTimeoutMs);
  const controller = new AbortController();

  if (deadlineMs <= 0) {
    logger.warn({ targetUrl, deadlineMs }, 'Downstream call aborted due to timeout');
    controller.abort();
    return { signal: controller.signal, cleanup: () => undefined };
  }

  const timer = setTimeout(() => {
    logger.warn({ targetUrl, deadlineMs }, 'Downstream call aborted due to timeout');
    controller.abort();
  }, deadlineMs);

  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
  };
}

export async function fetchUpstream(
  request: FastifyRequest,
  url: string,
  init: RequestInit,
  logger: FastifyBaseLogger,
  defaultTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
): Promise<Response> {
  const { signal, cleanup } = createDownstreamAbortSignal(request, logger, url, defaultTimeoutMs);

  try {
    return await fetch(url, { ...init, signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new UpstreamTimeoutError(`Upstream request to ${url} timed out`);
    }
    throw err;
  } finally {
    cleanup();
  }
}
