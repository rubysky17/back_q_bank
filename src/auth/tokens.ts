import { createHash, timingSafeEqual } from 'node:crypto';
import { sign, verify } from 'hono/jwt';

export interface AccessTokenPayload {
  sub: string;
  sid: string;
}

export async function signAccessToken(
  payload: AccessTokenPayload,
  secret: string,
  ttlSeconds: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign({ ...payload, iat: now, exp: now + ttlSeconds }, secret, 'HS256');
}

/** null when the token is malformed, tampered with or expired. */
export async function verifyAccessToken(
  token: string,
  secret: string,
): Promise<AccessTokenPayload | null> {
  try {
    const { sub, sid } = await verify(token, secret, 'HS256');
    return typeof sub === 'string' && typeof sid === 'string'
      ? { sub, sid }
      : null;
  } catch {
    return null;
  }
}

/** Constant-time string comparison (hashing first makes the lengths equal). */
export function sameSecret(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : undefined;
}
