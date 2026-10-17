import { eq } from 'drizzle-orm';

import { sessions } from '../src/db/schema';
import {
  createTestContext,
  resetDatabase,
  signInAsAdmin,
  type TestContext,
} from './helpers';

describe('Auth — single-account mode (e2e)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
    await resetDatabase(ctx.db);
  });

  afterAll(async () => {
    await ctx.close();
  });

  describe('login', () => {
    it('signs in the configured account as ADMIN and returns tokens', async () => {
      const res = await ctx.api
        .post('/auth/login')
        .send({
          email: `  ${ctx.config.ADMIN_EMAIL.toUpperCase()} `,
          password: ctx.config.ADMIN_PASSWORD,
          deviceId: 'device-1',
          platform: 'ANDROID',
        })
        .expect(200);
      expect(res.body.user).toMatchObject({
        email: ctx.config.ADMIN_EMAIL,
        fullName: 'Test Admin',
        role: 'ADMIN',
        isActive: true,
      });
      expect(res.body.user.passwordHash).toBeUndefined();
      expect(res.body.accessTokenExpiresIn).toBe(900);
      expect(typeof res.body.refreshToken).toBe('string');

      const me = await ctx.api
        .get('/auth/me', res.body.accessToken)
        .expect(200);
      expect(me.body.email).toBe(ctx.config.ADMIN_EMAIL);
    });

    it('reuses the same user row on every sign-in', async () => {
      const first = await signInAsAdmin(ctx);
      const second = await signInAsAdmin(ctx);
      expect(second.id).toBe(first.id);
    });

    it('uses the same error for a wrong password and an unknown email', async () => {
      const wrong = await ctx.api
        .post('/auth/login')
        .send({ email: ctx.config.ADMIN_EMAIL, password: 'WrongPass123' })
        .expect(401);
      const unknown = await ctx.api
        .post('/auth/login')
        .send({
          email: 'nobody@example.com',
          password: ctx.config.ADMIN_PASSWORD,
        })
        .expect(401);
      expect(wrong.body.code).toBe('INVALID_CREDENTIALS');
      expect(unknown.body).toEqual(wrong.body);
    });

    it('returns validation errors as one string message plus details', async () => {
      const res = await ctx.api
        .post('/auth/login')
        .send({ email: 'not-an-email', role: 'ADMIN' })
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(typeof res.body.message).toBe('string');
      const fields = res.body.details.map((d: { field: string }) => d.field);
      expect(fields).toEqual(
        expect.arrayContaining(['email', 'password', 'role']),
      );
    });

    it('rejects a body that is not JSON', async () => {
      const res = await ctx.api.post('/auth/login').raw('{nope').expect(400);
      expect(res.body).toMatchObject({
        code: 'BAD_REQUEST',
        message: 'Request body is not valid JSON',
      });
    });

    it('has no registration endpoint', async () => {
      const res = await ctx.api
        .post('/auth/register')
        .send({
          email: 'x@example.com',
          password: 'Passw0rd!123',
          fullName: 'X',
        })
        .expect(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });

    it('is rate limited per IP when the binding says so', async () => {
      const limited = ctx.apiWith({
        AUTH_LIMITER: { limit: async () => ({ success: false }) },
      });
      const res = await limited
        .post('/auth/login')
        .send({
          email: ctx.config.ADMIN_EMAIL,
          password: ctx.config.ADMIN_PASSWORD,
        })
        .expect(429);
      expect(res.body.code).toBe('TOO_MANY_REQUESTS');
    });

    it('requires a token on protected routes', async () => {
      const res = await ctx.api.get('/auth/me').expect(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
      const garbage = await ctx.api.get('/auth/me', 'garbage').expect(401);
      expect(garbage.body.code).toBe('TOKEN_INVALID');
    });
  });

  describe('refresh token rotation', () => {
    it('rotates, tolerates a retry within the grace window and detects reuse after it', async () => {
      const admin = await signInAsAdmin(ctx);

      const first = await ctx.api
        .post('/auth/refresh')
        .send({ refreshToken: admin.refreshToken })
        .expect(200);
      expect(first.body.refreshToken).not.toBe(admin.refreshToken);
      expect(first.body.user.id).toBe(admin.id);

      // Same old token again right away (lost response / concurrent refresh): still accepted.
      const retry = await ctx.api
        .post('/auth/refresh')
        .send({ refreshToken: admin.refreshToken })
        .expect(200);

      // Pretend the last rotation happened 2 minutes ago, then replay the previous token.
      const sessionId = admin.refreshToken.split('.')[0];
      await ctx.db
        .update(sessions)
        .set({ rotatedAt: new Date(Date.now() - 120_000) })
        .where(eq(sessions.id, sessionId));
      const replay = await ctx.api
        .post('/auth/refresh')
        .send({ refreshToken: first.body.refreshToken })
        .expect(401);
      expect(replay.body.code).toBe('REFRESH_TOKEN_REUSED');

      // The whole session is gone: newest refresh token and access token stop working.
      await ctx.api
        .post('/auth/refresh')
        .send({ refreshToken: retry.body.refreshToken })
        .expect(401);
      const me = await ctx.api
        .get('/auth/me', retry.body.accessToken)
        .expect(401);
      expect(me.body.code).toBe('SESSION_ENDED');
    });

    it('rejects malformed refresh tokens', async () => {
      const res = await ctx.api
        .post('/auth/refresh')
        .send({ refreshToken: 'not-a-token' })
        .expect(401);
      expect(res.body.code).toBe('REFRESH_TOKEN_INVALID');
    });
  });

  describe('sessions', () => {
    it('logout ends the session immediately', async () => {
      const admin = await signInAsAdmin(ctx);
      await ctx.api.post('/auth/logout', admin.token).expect(204);
      await ctx.api.get('/auth/me', admin.token).expect(401);
      await ctx.api
        .post('/auth/refresh')
        .send({ refreshToken: admin.refreshToken })
        .expect(401);
    });

    it('signing in again on the same device replaces the old session', async () => {
      const first = await signInAsAdmin(ctx, { deviceId: 'phone-1' });
      const second = await signInAsAdmin(ctx, { deviceId: 'phone-1' });
      await ctx.api.get('/auth/me', first.token).expect(401);
      await ctx.api.get('/auth/me', second.token).expect(200);
    });
  });

  describe('platform', () => {
    it('reports health with a database round trip', async () => {
      const res = await ctx.api.get('/health').expect(200);
      expect(res.body).toMatchObject({ status: 'ok', database: 'up' });
    });

    it('describes itself at the root URL', async () => {
      const res = await ctx.app.request('/', {}, ctx.env);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        api: '/api/v1',
        health: '/api/v1/health',
      });
    });

    it('answers unknown routes with the standard error body', async () => {
      const res = await ctx.api.get('/nope').expect(404);
      expect(res.body).toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
    });

    it('rejects bodies over 100 kB', async () => {
      const admin = await signInAsAdmin(ctx);
      const res = await ctx.api
        .post('/topics', admin.token)
        .send({ name: 'Big', description: 'x'.repeat(110 * 1024) })
        .expect(413);
      expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
    });
  });
});
