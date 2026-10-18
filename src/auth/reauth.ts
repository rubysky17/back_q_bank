import { sign, verify } from 'hono/jwt';

import type { Config } from '../env';
import { AppError } from '../lib/app-error';

/** How long a password confirmation stays valid for a sensitive change. */
export const REAUTH_TTL_SECONDS = 5 * 60;

const PURPOSE = 'reauth';

interface ReauthSubject {
  userId: string;
  /** Bound to the session that confirmed the password: another device can't reuse it. */
  sessionId: string;
}

/** Short-lived proof that the user just typed their password (HS256, no extra hashing). */
export async function issueReauthToken(
  config: Config,
  { userId, sessionId }: ReauthSubject,
) {
  const now = Math.floor(Date.now() / 1000);
  const reauthToken = await sign(
    {
      sub: userId,
      sid: sessionId,
      purpose: PURPOSE,
      iat: now,
      exp: now + REAUTH_TTL_SECONDS,
    },
    config.JWT_ACCESS_SECRET,
    'HS256',
  );
  return { reauthToken, expiresIn: REAUTH_TTL_SECONDS };
}

/** Throws REAUTH_REQUIRED (400, not 401: the session itself is fine) unless the token matches. */
export async function verifyReauthToken(
  config: Config,
  token: string,
  { userId, sessionId }: ReauthSubject,
) {
  try {
    const payload = await verify(token, config.JWT_ACCESS_SECRET, 'HS256');
    if (
      payload.purpose === PURPOSE &&
      payload.sub === userId &&
      payload.sid === sessionId
    ) {
      return;
    }
  } catch {
    // Expired or tampered with: same answer as a mismatch.
  }
  throw AppError.badRequest(
    'REAUTH_REQUIRED',
    'Please confirm your password again',
  );
}
