export const DEV_ALLOWED_ORIGINS_DEFAULT = 'http://localhost:3000,http://localhost:5173';

export function normalizeOrigin(origin: string): string {
  const trimmed = origin.trim();
  const withoutTrailingSlash = trimmed.replace(/\/+$/, '');
  return withoutTrailingSlash.toLowerCase();
}

export function isValidOriginUrl(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function parseAllowedOrigins(raw: string): string[] {
  return raw
    .split(',')
    .map((origin) => normalizeOrigin(origin))
    .filter(Boolean);
}

export function resolveAllowedOrigins(
  rawEnv: Record<string, unknown>
): { origins: string[]; error?: string } {
  const nodeEnv = (rawEnv.NODE_ENV as string | undefined) ?? 'development';

  if (nodeEnv === 'production' && (rawEnv.ALLOWED_ORIGINS === undefined || rawEnv.ALLOWED_ORIGINS === '')) {
    return { origins: [], error: 'ALLOWED_ORIGINS is required in production' };
  }

  const raw =
    typeof rawEnv.ALLOWED_ORIGINS === 'string' && rawEnv.ALLOWED_ORIGINS.length > 0
      ? rawEnv.ALLOWED_ORIGINS
      : DEV_ALLOWED_ORIGINS_DEFAULT;

  const origins = parseAllowedOrigins(raw);

  for (const origin of origins) {
    if (!isValidOriginUrl(origin)) {
      return { origins: [], error: `"${origin}" is not a valid URL` };
    }
  }

  return { origins };
}
