import {
  createTestContext,
  PASSWORD,
  resetDatabase,
  Role,
  signInAs,
  type TestContext,
} from './helpers.js';

describe('Auth & admin (e2e)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
    await resetDatabase(ctx.prisma);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  describe('register / login', () => {
    it('registers a USER and returns tokens', async () => {
      const res = await ctx.api
        .post('/auth/register')
        .send({
          email: '  New.User@Example.com ',
          password: PASSWORD,
          fullName: 'New User',
          deviceId: 'device-1',
          platform: 'ANDROID',
        })
        .expect(201);
      expect(res.body.user).toMatchObject({
        email: 'new.user@example.com',
        role: 'USER',
      });
      expect(res.body.user.passwordHash).toBeUndefined();
      expect(res.body.accessTokenExpiresIn).toBe(900);

      const me = await ctx.api
        .get('/auth/me', res.body.accessToken)
        .expect(200);
      expect(me.body.email).toBe('new.user@example.com');
    });

    it('rejects a duplicate email', async () => {
      const res = await ctx.api
        .post('/auth/register')
        .send({
          email: 'new.user@example.com',
          password: PASSWORD,
          fullName: 'Dup',
        })
        .expect(409);
      expect(res.body).toMatchObject({ code: 'EMAIL_TAKEN', statusCode: 409 });
    });

    it('returns validation errors as one string message plus details', async () => {
      const res = await ctx.api
        .post('/auth/register')
        .send({ email: 'not-an-email', password: 'short', role: 'ADMIN' })
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(typeof res.body.message).toBe('string');
      const fields = res.body.details.map((d: { field: string }) => d.field);
      expect(fields).toEqual(
        expect.arrayContaining(['email', 'password', 'fullName', 'role']),
      );
    });

    it('uses the same error for a wrong password and an unknown email', async () => {
      const wrong = await ctx.api
        .post('/auth/login')
        .send({ email: 'new.user@example.com', password: 'WrongPass123' })
        .expect(401);
      const unknown = await ctx.api
        .post('/auth/login')
        .send({ email: 'nobody@example.com', password: 'WrongPass123' })
        .expect(401);
      expect(wrong.body.code).toBe('INVALID_CREDENTIALS');
      expect(unknown.body).toEqual(wrong.body);
    });

    it('requires a token on protected routes', async () => {
      const res = await ctx.api.get('/auth/me').expect(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
      await ctx.api.get('/auth/me', 'garbage').expect(401);
    });
  });

  describe('refresh token rotation', () => {
    it('rotates, tolerates a retry within the grace window and detects reuse after it', async () => {
      const user = await signInAs(ctx, Role.USER);

      const first = await ctx.api
        .post('/auth/refresh')
        .send({ refreshToken: user.refreshToken })
        .expect(200);
      expect(first.body.refreshToken).not.toBe(user.refreshToken);
      expect(first.body.user.id).toBe(user.id);

      // Same old token again right away (lost response / concurrent refresh): still accepted.
      const retry = await ctx.api
        .post('/auth/refresh')
        .send({ refreshToken: user.refreshToken })
        .expect(200);

      // Pretend the last rotation happened 2 minutes ago, then replay the previous token.
      const sessionId = user.refreshToken.split('.')[0];
      await ctx.prisma.session.update({
        where: { id: sessionId },
        data: { rotatedAt: new Date(Date.now() - 120_000) },
      });
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
      const user = await signInAs(ctx, Role.USER);
      await ctx.api.post('/auth/logout', user.token).expect(204);
      await ctx.api.get('/auth/me', user.token).expect(401);
      await ctx.api
        .post('/auth/refresh')
        .send({ refreshToken: user.refreshToken })
        .expect(401);
    });

    it('signing in again on the same device replaces the old session', async () => {
      const user = await signInAs(ctx, Role.USER);
      const login = () =>
        ctx.api
          .post('/auth/login')
          .send({ email: user.email, password: PASSWORD, deviceId: 'phone-1' })
          .expect(200);
      const first = await login();
      const second = await login();
      await ctx.api.get('/auth/me', first.body.accessToken).expect(401);
      await ctx.api.get('/auth/me', second.body.accessToken).expect(200);
    });

    it('changing the password signs out the other devices only', async () => {
      const user = await signInAs(ctx, Role.USER);
      const other = await ctx.api
        .post('/auth/login')
        .send({ email: user.email, password: PASSWORD, deviceId: 'tablet' })
        .expect(200);

      const wrong = await ctx.api
        .patch('/auth/password', user.token)
        .send({ currentPassword: 'nope-nope', newPassword: 'NewPassw0rd!' })
        .expect(400);
      expect(wrong.body.code).toBe('WRONG_PASSWORD');

      await ctx.api
        .patch('/auth/password', user.token)
        .send({ currentPassword: PASSWORD, newPassword: 'NewPassw0rd!' })
        .expect(204);
      await ctx.api.get('/auth/me', user.token).expect(200);
      await ctx.api.get('/auth/me', other.body.accessToken).expect(401);
      await ctx.api
        .post('/auth/login')
        .send({ email: user.email, password: 'NewPassw0rd!' })
        .expect(200);
    });
  });

  describe('admin', () => {
    it('only admins can list users', async () => {
      const user = await signInAs(ctx, Role.USER);
      const host = await signInAs(ctx, Role.HOST);
      const admin = await signInAs(ctx, Role.ADMIN);
      await ctx.api.get('/admin/users', user.token).expect(403);
      await ctx.api.get('/admin/users', host.token).expect(403);

      const res = await ctx.api
        .get(
          `/admin/users?role=HOST&q=${encodeURIComponent(host.email)}`,
          admin.token,
        )
        .expect(200);
      expect(res.body).toMatchObject({ total: 1, page: 1, limit: 20 });
      expect(res.body.items[0].id).toBe(host.id);
    });

    it('promotion to HOST applies to the very next request', async () => {
      const user = await signInAs(ctx, Role.USER);
      const admin = await signInAs(ctx, Role.ADMIN);
      const topic = { name: `Topic ${user.id}` };

      await ctx.api.post('/topics', user.token).send(topic).expect(403);
      const promoted = await ctx.api
        .patch(`/admin/users/${user.id}/role`, admin.token)
        .send({ role: 'HOST' })
        .expect(200);
      expect(promoted.body.role).toBe('HOST');
      await ctx.api.post('/topics', user.token).send(topic).expect(201);
    });

    it('cannot change admins, itself, or grant ADMIN', async () => {
      const admin = await signInAs(ctx, Role.ADMIN);
      const otherAdmin = await signInAs(ctx, Role.ADMIN);
      const user = await signInAs(ctx, Role.USER);

      await ctx.api
        .patch(`/admin/users/${otherAdmin.id}/role`, admin.token)
        .send({ role: 'USER' })
        .expect(403);
      const self = await ctx.api
        .patch(`/admin/users/${admin.id}/status`, admin.token)
        .send({ isActive: false })
        .expect(400);
      expect(self.body.code).toBe('CANNOT_MODIFY_SELF');
      await ctx.api
        .patch(`/admin/users/${user.id}/role`, admin.token)
        .send({ role: 'ADMIN' })
        .expect(400);
    });

    it('disabling an account signs it out and blocks login', async () => {
      const admin = await signInAs(ctx, Role.ADMIN);
      const user = await signInAs(ctx, Role.USER);
      await ctx.api
        .patch(`/admin/users/${user.id}/status`, admin.token)
        .send({ isActive: false })
        .expect(200);
      await ctx.api.get('/auth/me', user.token).expect(401);
      const login = await ctx.api
        .post('/auth/login')
        .send({ email: user.email, password: PASSWORD })
        .expect(403);
      expect(login.body.code).toBe('ACCOUNT_DISABLED');
    });
  });
});
