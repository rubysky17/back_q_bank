import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Refresh tokens are opaque strings `${sessionId}.${secret}`.
 * Only sha256(secret) is stored, so a database leak does not leak usable tokens.
 */
export const newSecret = () => randomBytes(32).toString('base64url');

export const hashSecret = (secret: string) =>
  createHash('sha256').update(secret).digest('base64url');

export const formatRefreshToken = (sessionId: string, secret: string) =>
  `${sessionId}.${secret}`;

export function parseRefreshToken(
  token: string,
): { sessionId: string; secret: string } | null {
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const sessionId = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  if (!UUID_RE.test(sessionId) || secret.length < 16) return null;
  return { sessionId, secret };
}

/** Constant-time comparison of two stored hashes. */
export function sameHash(stored: string | null | undefined, presented: string) {
  if (!stored) return false;
  const a = Buffer.from(stored);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}
