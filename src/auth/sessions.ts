import { and, eq, isNull } from 'drizzle-orm';

import type { Db } from '../db/client';
import { type Platform, sessions, users } from '../db/schema';
import type { Config } from '../env';
import { AppError } from '../lib/app-error';
import { uuidv7 } from '../lib/uuidv7';
import {
  formatRefreshToken,
  hashSecret,
  newSecret,
  parseRefreshToken,
  sameHash,
} from './refresh-token';
import { signAccessToken } from './tokens';

/** A previous refresh token stays usable this long after rotation (lost responses, app resume retries). */
export const REFRESH_GRACE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface DeviceInfo {
  deviceId?: string;
  deviceName?: string;
  platform?: Platform;
}

export interface ClientMeta {
  ip?: string;
  userAgent?: string;
}

export interface AuthTokens {
  accessToken: string;
  /** Seconds. */
  accessTokenExpiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

const invalidRefreshToken = () =>
  AppError.unauthorized(
    'REFRESH_TOKEN_INVALID',
    'Refresh token is invalid or expired',
  );

/** Sliding expiry: every successful refresh extends the session. */
const refreshExpiry = (config: Config, from: Date) =>
  new Date(from.getTime() + config.REFRESH_TTL_DAYS * DAY_MS);

async function issue(
  config: Config,
  userId: string,
  sessionId: string,
  secret: string,
  refreshTokenExpiresAt: Date,
): Promise<AuthTokens> {
  return {
    accessToken: await signAccessToken(
      { sub: userId, sid: sessionId },
      config.JWT_ACCESS_SECRET,
      config.JWT_ACCESS_TTL_SECONDS,
    ),
    accessTokenExpiresIn: config.JWT_ACCESS_TTL_SECONDS,
    refreshToken: formatRefreshToken(sessionId, secret),
    refreshTokenExpiresAt,
  };
}

/** Starts a session. Signing in again on the same device ends that device's previous session. */
export async function createSession(
  db: Db,
  config: Config,
  userId: string,
  device: DeviceInfo,
  meta: ClientMeta,
): Promise<AuthTokens> {
  const now = new Date();
  const secret = newSecret();
  const session = {
    id: uuidv7(),
    userId,
    secretHash: hashSecret(secret),
    deviceId: device.deviceId,
    deviceName: device.deviceName,
    platform: device.platform,
    ip: meta.ip,
    userAgent: meta.userAgent,
    expiresAt: refreshExpiry(config, now),
  };
  const insert = db.insert(sessions).values(session);
  if (device.deviceId) {
    await db.batch([
      db
        .update(sessions)
        .set({ revokedAt: now })
        .where(
          and(
            eq(sessions.userId, userId),
            eq(sessions.deviceId, device.deviceId),
            isNull(sessions.revokedAt),
          ),
        ),
      insert,
    ]);
  } else {
    await insert;
  }
  return issue(config, userId, session.id, secret, session.expiresAt);
}

/**
 * Rotates the refresh token (compare-and-swap on the stored hash).
 * - current secret → new pair
 * - previous secret within REFRESH_GRACE_MS → new pair (concurrent refresh / lost response)
 * - previous secret after the grace window → token was replayed: the session is revoked
 */
export async function rotateSession(
  db: Db,
  config: Config,
  refreshToken: string,
  meta: ClientMeta,
): Promise<{ userId: string; tokens: AuthTokens }> {
  const parsed = parseRefreshToken(refreshToken);
  if (!parsed) throw invalidRefreshToken();
  const presented = hashSecret(parsed.secret);

  // Retry when a concurrent refresh of the same session wins the race.
  for (let round = 0; round < 3; round++) {
    const [session] = await db
      .select({
        id: sessions.id,
        userId: sessions.userId,
        secretHash: sessions.secretHash,
        prevSecretHash: sessions.prevSecretHash,
        rotatedAt: sessions.rotatedAt,
        revokedAt: sessions.revokedAt,
        expiresAt: sessions.expiresAt,
        isActive: users.isActive,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.id, parsed.sessionId))
      .limit(1);
    const now = new Date();
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt <= now ||
      !session.isActive
    ) {
      throw invalidRefreshToken();
    }

    const isCurrent = sameHash(session.secretHash, presented);
    const isPrevious = sameHash(session.prevSecretHash, presented);
    const withinGrace =
      session.rotatedAt !== null &&
      now.getTime() - session.rotatedAt.getTime() <= REFRESH_GRACE_MS;

    if (!isCurrent && !(isPrevious && withinGrace)) {
      if (isPrevious) {
        await revokeSession(db, session.id);
        throw AppError.unauthorized(
          'REFRESH_TOKEN_REUSED',
          'This refresh token was already used; please sign in again',
        );
      }
      throw invalidRefreshToken();
    }

    const secret = newSecret();
    const expiresAt = refreshExpiry(config, now);
    const swapped = await db
      .update(sessions)
      .set({
        secretHash: hashSecret(secret),
        prevSecretHash: session.secretHash,
        rotatedAt: now,
        lastUsedAt: now,
        expiresAt,
        ip: meta.ip,
        userAgent: meta.userAgent,
      })
      .where(
        and(
          eq(sessions.id, session.id),
          eq(sessions.secretHash, session.secretHash),
          isNull(sessions.revokedAt),
        ),
      )
      .returning({ id: sessions.id });
    if (swapped.length === 1) {
      return {
        userId: session.userId,
        tokens: await issue(
          config,
          session.userId,
          session.id,
          secret,
          expiresAt,
        ),
      };
    }
  }
  throw invalidRefreshToken();
}

export async function revokeSession(db: Db, sessionId: string) {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
}
