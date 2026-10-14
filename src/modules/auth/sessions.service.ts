import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

import { AppError } from '../../common/errors/app-error.js';
import type { AccessTokenPayload } from '../../common/guards/jwt-auth.guard.js';
import type { Env } from '../../config/env.js';
import type { Platform } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  formatRefreshToken,
  hashSecret,
  newSecret,
  parseRefreshToken,
  sameHash,
} from './refresh-token.js';

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

@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Starts a session. Signing in again on the same device ends that device's previous session. */
  async create(
    userId: string,
    device: DeviceInfo,
    meta: ClientMeta,
  ): Promise<AuthTokens> {
    const now = new Date();
    if (device.deviceId) {
      await this.prisma.session.updateMany({
        where: { userId, deviceId: device.deviceId, revokedAt: null },
        data: { revokedAt: now },
      });
    }

    const secret = newSecret();
    const session = await this.prisma.session.create({
      data: {
        userId,
        secretHash: hashSecret(secret),
        deviceId: device.deviceId,
        deviceName: device.deviceName,
        platform: device.platform,
        ip: meta.ip,
        userAgent: meta.userAgent,
        expiresAt: this.refreshExpiry(now),
      },
      select: { id: true, expiresAt: true },
    });
    return this.issue(userId, session.id, secret, session.expiresAt);
  }

  /**
   * Rotates the refresh token (compare-and-swap on the stored hash).
   * - current secret → new pair
   * - previous secret within REFRESH_GRACE_MS → new pair (concurrent refresh / lost response)
   * - previous secret after the grace window → token was replayed: the session is revoked
   */
  async rotate(
    refreshToken: string,
    meta: ClientMeta,
  ): Promise<{ userId: string; tokens: AuthTokens }> {
    const parsed = parseRefreshToken(refreshToken);
    if (!parsed) throw invalidRefreshToken();
    const presented = hashSecret(parsed.secret);

    // Retry when a concurrent refresh of the same session wins the race.
    for (let round = 0; round < 3; round++) {
      const session = await this.prisma.session.findUnique({
        where: { id: parsed.sessionId },
        select: {
          id: true,
          userId: true,
          secretHash: true,
          prevSecretHash: true,
          rotatedAt: true,
          revokedAt: true,
          expiresAt: true,
          user: { select: { isActive: true } },
        },
      });
      const now = new Date();
      if (
        !session ||
        session.revokedAt ||
        session.expiresAt <= now ||
        !session.user.isActive
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
          await this.revoke(session.id);
          throw AppError.unauthorized(
            'REFRESH_TOKEN_REUSED',
            'This refresh token was already used; please sign in again',
          );
        }
        throw invalidRefreshToken();
      }

      const secret = newSecret();
      const expiresAt = this.refreshExpiry(now);
      const { count } = await this.prisma.session.updateMany({
        where: {
          id: session.id,
          secretHash: session.secretHash,
          revokedAt: null,
        },
        data: {
          secretHash: hashSecret(secret),
          prevSecretHash: session.secretHash,
          rotatedAt: now,
          lastUsedAt: now,
          expiresAt,
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
      });
      if (count === 1) {
        return {
          userId: session.userId,
          tokens: this.issue(session.userId, session.id, secret, expiresAt),
        };
      }
    }
    throw invalidRefreshToken();
  }

  async revoke(sessionId: string) {
    await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Ends every session of the user, optionally keeping one (e.g. the device that changed the password). */
  async revokeAllForUser(userId: string, exceptSessionId?: string) {
    await this.prisma.session.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
      },
      data: { revokedAt: new Date() },
    });
  }

  private issue(
    userId: string,
    sessionId: string,
    secret: string,
    refreshTokenExpiresAt: Date,
  ): AuthTokens {
    const payload: AccessTokenPayload = { sub: userId, sid: sessionId };
    return {
      accessToken: this.jwt.sign(payload),
      accessTokenExpiresIn: this.config.get('JWT_ACCESS_TTL_SECONDS', {
        infer: true,
      }),
      refreshToken: formatRefreshToken(sessionId, secret),
      refreshTokenExpiresAt,
    };
  }

  /** Sliding expiry: every successful refresh extends the session. */
  private refreshExpiry(from: Date) {
    const days = this.config.get('REFRESH_TTL_DAYS', { infer: true });
    return new Date(from.getTime() + days * DAY_MS);
  }
}
