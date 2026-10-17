import { eq } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';

import { type Role, sessions, users } from '../db/schema';
import type { AppEnv } from '../env';
import { AppError } from '../lib/app-error';
import { bearerToken, verifyAccessToken } from './tokens';

/**
 * Verifies the access token, then loads the session + user by primary key so that logout,
 * disabled accounts and role changes take effect immediately instead of when the token expires.
 */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const token = bearerToken(c.req.header('authorization'));
  if (!token) {
    throw AppError.unauthorized('UNAUTHORIZED', 'Missing access token');
  }
  const payload = await verifyAccessToken(
    token,
    c.var.config.JWT_ACCESS_SECRET,
  );
  if (!payload) {
    throw AppError.unauthorized(
      'TOKEN_INVALID',
      'Access token is invalid or expired',
    );
  }

  const db = c.var.db;
  const [row] = await db
    .select({
      userId: sessions.userId,
      revokedAt: sessions.revokedAt,
      expiresAt: sessions.expiresAt,
      email: users.email,
      fullName: users.fullName,
      role: users.role,
      isActive: users.isActive,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, payload.sid))
    .limit(1);
  if (
    !row ||
    row.userId !== payload.sub ||
    row.revokedAt ||
    row.expiresAt <= new Date() ||
    !row.isActive
  ) {
    throw AppError.unauthorized(
      'SESSION_ENDED',
      'Your session has ended, please sign in again',
    );
  }

  c.set('user', {
    id: row.userId,
    email: row.email,
    fullName: row.fullName,
    role: row.role,
    sessionId: payload.sid,
  });
  await next();
});

/** Restricts a route to the given roles; use after requireAuth. */
export const requireRole = (...roles: Role[]) =>
  createMiddleware<AppEnv>(async (c, next) => {
    if (!roles.includes(c.var.user.role)) throw AppError.forbidden();
    await next();
  });

/** Login/refresh attempts per client IP (no-op when the binding is absent, e.g. in tests). */
export const authRateLimit = createMiddleware<AppEnv>(async (c, next) => {
  const limiter = c.env.AUTH_LIMITER as RateLimit | undefined;
  if (limiter) {
    const key = c.req.header('cf-connecting-ip') ?? 'unknown';
    const { success } = await limiter.limit({ key });
    if (!success) throw AppError.tooManyRequests();
  }
  await next();
});
