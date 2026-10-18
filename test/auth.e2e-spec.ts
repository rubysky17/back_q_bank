import { eq } from 'drizzle-orm';

import { sessions, users } from '../src/db/schema';
import {
  ADMIN,
  createAccount,
  createTestContext,
  resetDatabase,
  signInAsAdmin,
  type TestContext,
} from './helpers';

const newAccount = (label: string) => ({
  email: `${label}@example.com`,
  password: 'Customer-Pass-1',
  fullName: `Customer ${label}`,
});

describe('Auth — email/password accounts (e2e)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
    await resetDatabase(ctx.db);
  });

  afterAll(async () => {
    await ctx.close();
  });

  describe('register', () => {
    it('creates a USER account and signs it in', async () => {
      const res = await ctx.api
        .post('/auth/register')
        .send({
          ...newAccount('alice'),
          email: '  Alice@Example.com ',
          deviceId: 'device-1',
          platform: 'IOS',
        })
        .expect(201);
      expect(res.body.user).toMatchObject({
        email: 'alice@example.com',
        fullName: 'Customer alice',
        role: 'USER',
        isActive: true,
      });
      expect(res.body.user.passwordHash).toBeUndefined();
      expect(typeof res.body.refreshToken).toBe('string');

      const me = await ctx.api
        .get('/auth/me', res.body.accessToken)
        .expect(200);
      expect(me.body.email).toBe('alice@example.com');

      const [row] = await ctx.db
        .select({ passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.email, 'alice@example.com'));
      expect(row.passwordHash).toMatch(/^pbkdf2-sha256\$10000\$/);
    });

    it('lets the new account sign in with its password', async () => {
      const account = newAccount('bob');
      await ctx.api.post('/auth/register').send(account).expect(201);
      const res = await ctx.api
        .post('/auth/login')
        .send({ email: account.email, password: account.password })
        .expect(200);
      expect(res.body.user).toMatchObject({
        email: account.email,
        role: 'USER',
      });
    });

    it('refuses an email that already has an account, whatever its case', async () => {
      await ctx.api
        .post('/auth/register')
        .send(newAccount('carol'))
        .expect(201);
      const res = await ctx.api
        .post('/auth/register')
        .send({ ...newAccount('carol'), email: 'CAROL@example.com' })
        .expect(409);
      expect(res.body).toMatchObject({
        code: 'EMAIL_TAKEN',
        message: 'An account with this email already exists',
      });
    });

    it('validates the password length and the name, and never accepts a role', async () => {
      const res = await ctx.api
        .post('/auth/register')
        .send({
          email: 'dave@example.com',
          password: 'short',
          fullName: '   ',
          role: 'ADMIN',
        })
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      const fields = res.body.details.map((d: { field: string }) => d.field);
      expect(fields).toEqual(
        expect.arrayContaining(['password', 'fullName', 'role']),
      );
    });

    it('is rate limited per IP when the binding says so', async () => {
      const limited = ctx.apiWith({
        AUTH_LIMITER: { limit: async () => ({ success: false }) },
      });
      const res = await limited
        .post('/auth/register')
        .send(newAccount('erin'))
        .expect(429);
      expect(res.body.code).toBe('TOO_MANY_REQUESTS');
    });
  });

  describe('login', () => {
    it('signs in a seeded admin and returns tokens', async () => {
      await createAccount(ctx, { ...ADMIN, role: 'ADMIN' });
      const res = await ctx.api
        .post('/auth/login')
        .send({
          email: `  ${ADMIN.email.toUpperCase()} `,
          password: ADMIN.password,
          deviceId: 'device-1',
          platform: 'ANDROID',
        })
        .expect(200);
      expect(res.body.user).toMatchObject({
        email: ADMIN.email,
        fullName: ADMIN.fullName,
        role: 'ADMIN',
        isActive: true,
      });
      expect(res.body.user.passwordHash).toBeUndefined();
      expect(res.body.accessTokenExpiresIn).toBe(900);
      expect(typeof res.body.refreshToken).toBe('string');
    });

    it('uses the same error for a wrong password and an unknown email', async () => {
      await createAccount(ctx, { ...ADMIN, role: 'ADMIN' });
      const wrong = await ctx.api
        .post('/auth/login')
        .send({ email: ADMIN.email, password: 'WrongPass123' })
        .expect(401);
      const unknown = await ctx.api
        .post('/auth/login')
        .send({ email: 'nobody@example.com', password: ADMIN.password })
        .expect(401);
      expect(wrong.body.code).toBe('INVALID_CREDENTIALS');
      expect(unknown.body).toEqual(wrong.body);
    });

    it('never signs in a row without a real password hash', async () => {
      await ctx.db.insert(users).values({
        email: 'legacy@example.com',
        fullName: 'Legacy',
        passwordHash: '!',
      });
      const res = await ctx.api
        .post('/auth/login')
        .send({ email: 'legacy@example.com', password: '!' })
        .expect(401);
      expect(res.body.code).toBe('INVALID_CREDENTIALS');
    });

    it('refuses a disabled account', async () => {
      const account = newAccount('frank');
      await ctx.api.post('/auth/register').send(account).expect(201);
      await ctx.db
        .update(users)
        .set({ isActive: false })
        .where(eq(users.email, account.email));
      const res = await ctx.api
        .post('/auth/login')
        .send({ email: account.email, password: account.password })
        .expect(403);
      expect(res.body.code).toBe('ACCOUNT_DISABLED');
    });

    it('upgrades an old hash to the configured cost on sign-in', async () => {
      const account = newAccount('grace');
      await ctx.api.post('/auth/register').send(account).expect(201);
      const stronger = ctx.apiWith({ PASSWORD_HASH_ITERATIONS: '20000' });
      await stronger
        .post('/auth/login')
        .send({ email: account.email, password: account.password })
        .expect(200);
      const [row] = await ctx.db
        .select({ passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.email, account.email));
      expect(row.passwordHash).toMatch(/^pbkdf2-sha256\$20000\$/);
      // A lower configured cost never downgrades it, and it still verifies.
      await ctx.api
        .post('/auth/login')
        .send({ email: account.email, password: account.password })
        .expect(200);
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

    it('is rate limited per IP when the binding says so', async () => {
      const limited = ctx.apiWith({
        AUTH_LIMITER: { limit: async () => ({ success: false }) },
      });
      const res = await limited
        .post('/auth/login')
        .send({ email: ADMIN.email, password: ADMIN.password })
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

  describe('roles', () => {
    it('keeps self-registered users out of authoring routes', async () => {
      const res = await ctx.api
        .post('/auth/register')
        .send(newAccount('henry'))
        .expect(201);
      const denied = await ctx.api
        .post('/topics', res.body.accessToken)
        .send({ name: 'Not allowed' })
        .expect(403);
      expect(denied.body.code).toBe('FORBIDDEN');
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
