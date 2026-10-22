import {
  createTestContext,
  resetDatabase,
  Role,
  type SignedIn,
  signInAs,
  type TestContext,
} from './helpers';

interface Item {
  kind: string;
  key: string;
  value: unknown;
  deleted: boolean;
  updatedAt: number;
}

type Cursor = { rev: number; kind: string; key: string } | null;

const Q1 = '01900000-0000-7000-8000-000000000001';
const Q2 = '01900000-0000-7000-8000-000000000002';

function practice(
  key: string,
  at: number,
  optionId: string | null,
  checked = false,
) {
  return {
    kind: 'PRACTICE',
    key,
    value: { response: optionId ? { optionId } : null, checked },
    deleted: false,
    updatedAt: at,
  };
}

describe('User state sync (e2e)', () => {
  let ctx: TestContext;
  let user: SignedIn;
  let otherUser: SignedIn;
  const t0 = Date.now() - 60_000;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.db);
    user = await signInAs(ctx, Role.USER, 'learner');
    otherUser = await signInAs(ctx, Role.USER, 'other');
  });

  afterAll(async () => {
    await ctx.close();
  });

  const sync = (token: string, body: { cursor: Cursor; changes: unknown[] }) =>
    ctx.api
      .post('/me/sync', token)
      .send(body)
      .expect(200)
      .then((res) => res.body);

  it('requires a signed-in user', async () => {
    await ctx.api
      .post('/me/sync')
      .send({ cursor: null, changes: [] })
      .expect(401);
    await ctx.api.get('/me/sync-status').expect(401);
  });

  it('hands one device the answers another uploaded, and only to their owner', async () => {
    const pushed = await sync(user.token, {
      cursor: null,
      changes: [
        practice(Q1, t0, 'a', true),
        {
          kind: 'SETTING',
          key: 'reminder',
          value: { enabled: true, hour: 20, minute: 0 },
          deleted: false,
          updatedAt: t0,
        },
      ],
    });
    expect(pushed.items).toHaveLength(2);
    expect(pushed.rejected).toEqual([]);

    const otherDevice = await sync(user.token, { cursor: null, changes: [] });
    expect(otherDevice.items as Item[]).toEqual(
      expect.arrayContaining([
        {
          kind: 'PRACTICE',
          key: Q1,
          value: { response: { optionId: 'a' }, checked: true },
          deleted: false,
          updatedAt: t0,
        },
        expect.objectContaining({ kind: 'SETTING', key: 'reminder' }),
      ]),
    );
    expect(otherDevice.hasMore).toBe(false);

    const stranger = await sync(otherUser.token, { cursor: null, changes: [] });
    expect(stranger.items).toEqual([]);
  });

  it('keeps the newest change and sends back the winner to the device that lost', async () => {
    const first = await sync(user.token, {
      cursor: null,
      changes: [practice(Q1, t0 + 2_000, 'b')],
    });
    const stale = await sync(user.token, {
      cursor: first.cursor,
      changes: [practice(Q1, t0 + 1_000, 'a')],
    });
    expect(stale.items).toEqual([
      expect.objectContaining({
        key: Q1,
        value: { response: { optionId: 'b' }, checked: false },
        updatedAt: t0 + 2_000,
      }),
    ]);
  });

  it('syncs deletes as tombstones, which a first sync skips', async () => {
    const first = await sync(user.token, {
      cursor: null,
      changes: [practice(Q1, t0, 'a'), practice(Q2, t0, 'b')],
    });
    const deleted = await sync(user.token, {
      cursor: first.cursor,
      changes: [
        {
          kind: 'PRACTICE',
          key: Q1,
          value: null,
          deleted: true,
          updatedAt: t0 + 1,
        },
      ],
    });
    expect(deleted.items).toEqual([
      expect.objectContaining({ key: Q1, deleted: true, value: null }),
    ]);

    // A device that kept the old cursor learns about the delete.
    const behind = await sync(user.token, {
      cursor: first.cursor,
      changes: [],
    });
    expect(behind.items).toEqual([
      expect.objectContaining({ key: Q1, deleted: true }),
    ]);

    const fresh = await sync(user.token, { cursor: null, changes: [] });
    expect((fresh.items as Item[]).map((item) => item.key)).toEqual([Q2]);
  });

  it('refuses items that do not fit their kind, one by one', async () => {
    const result = await sync(user.token, {
      cursor: null,
      changes: [
        practice('not-a-uuid', t0, 'a'),
        {
          kind: 'SETTING',
          key: 'theme',
          value: 'dark',
          deleted: false,
          updatedAt: t0,
        },
        {
          kind: 'SETTING',
          key: 'language',
          value: 'fr',
          deleted: false,
          updatedAt: t0,
        },
        { kind: 'OTHER', key: 'x', value: 1, deleted: false, updatedAt: t0 },
        {
          kind: 'SETTING',
          key: 'dailyGoal',
          value: 20,
          deleted: false,
          updatedAt: t0,
        },
      ],
    });
    expect(result.rejected).toHaveLength(4);
    expect(result.items).toEqual([
      expect.objectContaining({ kind: 'SETTING', key: 'dailyGoal', value: 20 }),
    ]);
  });

  it('pages through many items with the cursor', async () => {
    const changes = Array.from({ length: 200 }, (_, i) =>
      practice(
        `01900000-0000-7000-8000-${String(i).padStart(12, '0')}`,
        t0,
        'a',
      ),
    );
    await sync(user.token, { cursor: null, changes: changes.slice(0, 150) });
    await sync(user.token, { cursor: null, changes: changes.slice(150) });

    const page1 = await sync(user.token, { cursor: null, changes: [] });
    expect(page1.items).toHaveLength(200);
    expect(page1.hasMore).toBe(false);

    const extra = await sync(user.token, {
      cursor: page1.cursor,
      changes: [practice(Q1, t0, 'c')],
    });
    expect((extra.items as Item[]).map((item) => item.key)).toEqual([Q1]);
  });

  it('reports change markers other devices poll', async () => {
    const before = await ctx.api.get('/me/sync-status', user.token).expect(200);
    expect(before.body).toMatchObject({
      userStateRev: 0,
      vocabRev: 0,
      attemptsUpdatedAt: 0,
    });

    await sync(user.token, { cursor: null, changes: [practice(Q1, t0, 'a')] });
    const after = await ctx.api.get('/me/sync-status', user.token).expect(200);
    expect(after.body.userStateRev).toBeGreaterThan(0);

    const stranger = await ctx.api
      .get('/me/sync-status', otherUser.token)
      .expect(200);
    expect(stranger.body.userStateRev).toBe(0);
  });
});
