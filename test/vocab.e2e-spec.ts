import { termKey } from '../src/modules/vocab/term';
import {
  GOOGLE_VARIANTS,
  MICROSOFT_URL,
} from '../src/modules/vocab/translator';
import {
  createTestContext,
  resetDatabase,
  Role,
  type SignedIn,
  signInAs,
  type TestContext,
} from './helpers';

interface Item {
  key: string;
  term: string;
  kind: string;
  meaning: string | null;
  partOfSpeech: string | null;
  explanation: string | null;
  context: string | null;
  sourceTitle: string | null;
  deleted: boolean;
  translateFailed: boolean;
  createdAt: number;
  updatedAt: number;
}

/** A note as the app uploads it. */
function note(term: string, at: number, extra: Record<string, unknown> = {}) {
  return {
    key: termKey(term),
    term,
    context: `The ${term} is reviewed.`,
    sourceTitle: 'PMP Full Test 1',
    deleted: false,
    createdAt: at,
    updatedAt: at,
    ...extra,
  };
}

const DICTIONARY: Record<string, string> = {
  stakeholder: 'bên liên quan',
  Stakeholder: 'bên liên quan',
  baseline: 'đường cơ sở',
  float: 'thời gian dự trữ',
};

describe('Vocabulary sync (e2e)', () => {
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

  const sync = (
    token: string,
    body: { cursor: { rev: number; key: string } | null; changes: unknown[] },
    api = ctx.api,
  ) =>
    api
      .post('/vocab/sync', token)
      .send(body)
      .expect(200)
      .then((res) => res.body);

  /**
   * Stand-in for the free Google and Microsoft endpoints: answers per term (text, an HTTP error
   * status, or a thrown network error) and records the terms of every request. Both are down unless
   * a test says otherwise, so no test reaches the real services. Every other request (the local
   * D1) goes through the real fetch.
   */
  let answer: (term: string) => string | number | Error;
  let calls: string[];
  beforeEach(() => {
    answer = () => 503;
    calls = [];
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const isGoogle = GOOGLE_VARIANTS.some(({ base }) => url.startsWith(base));
      if (!isGoogle && !url.startsWith(MICROSOFT_URL)) {
        return realFetch(input, init);
      }
      const terms = isGoogle
        ? new URLSearchParams(String(init?.body))
            .getAll('q')
            .map((q) => q.replace(/&amp;/g, '&'))
        : (JSON.parse(String(init?.body)) as string[]);
      calls.push(...terms);
      const answers = terms.map((term) => answer(term));
      const failure = answers.find((value) => typeof value !== 'string');
      if (failure instanceof Error) throw failure;
      if (typeof failure === 'number') {
        return new Response('<html>unusual traffic</html>', {
          status: failure,
        });
      }
      return Response.json(
        isGoogle
          ? answers
          : answers.map((text) => ({ translations: [{ text, to: 'vi' }] })),
      );
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The translation engines answer with `fn` for the rest of the test. */
  const translateWith = (fn: typeof answer) => {
    answer = fn;
    return { calls, api: ctx.api };
  };

  const dictionary = () =>
    translateWith((term) => DICTIONARY[term] ?? `nghĩa của ${term}`);

  it('requires a session', async () => {
    const res = await ctx.api
      .post('/vocab/sync')
      .send({ cursor: null, changes: [] })
      .expect(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('validates the body', async () => {
    const changes = Array.from({ length: 51 }, (_, i) => note(`word${i}`, t0));
    const res = await ctx.api
      .post('/vocab/sync', user.token)
      .send({ cursor: null, changes })
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('stores uploaded notes once, even when uploaded twice', async () => {
    const body = {
      cursor: null,
      changes: [note('baseline', t0), note('critical path', t0)],
    };
    const first = await sync(user.token, body);
    expect(
      first.items.map((item: Item) => [item.key, item.kind, item.meaning]),
    ).toEqual([
      ['baseline', 'WORD', null],
      ['critical path', 'PHRASE', null],
    ]);
    expect(first).toMatchObject({
      hasMore: false,
      pending: 2,
      translateUnavailable: true,
      rejected: [],
    });
    expect(first.cursor).toMatchObject({ key: 'critical path' });

    const again = await sync(user.token, body);
    expect(again.items).toHaveLength(2);
    const { n } = (await ctx.db.$client
      .prepare('SELECT count(*) AS n FROM "VocabNote" WHERE "userId" = ?')
      .bind(user.id)
      .first<{ n: number }>())!;
    expect(n).toBe(2);

    // Nothing new after the cursor.
    const later = await sync(user.token, { cursor: again.cursor, changes: [] });
    expect(later.items).toEqual([]);
    expect(later.cursor).toEqual(again.cursor);
  });

  it('translates waiting notes and shares word translations', async () => {
    const { calls, api } = dictionary();
    const res = await sync(
      user.token,
      { cursor: null, changes: [note('stakeholder', t0)] },
      api,
    );
    expect(res.items[0]).toMatchObject({
      key: 'stakeholder',
      meaning: 'bên liên quan',
      partOfSpeech: null,
      translateFailed: false,
    });
    expect(res).toMatchObject({ pending: 0, translateUnavailable: false });
    expect(calls).toEqual(['stakeholder']);

    // Another user notes the same word: served from the shared cache.
    const other = await sync(
      otherUser.token,
      { cursor: null, changes: [note('Stakeholder', t0)] },
      api,
    );
    expect(other.items[0]).toMatchObject({
      key: 'stakeholder',
      term: 'Stakeholder',
      meaning: 'bên liên quan',
    });
    expect(calls).toEqual(['stakeholder']);
  });

  it('never caches sentences', async () => {
    const { calls, api } = dictionary();
    const sentence =
      'The sponsor approves the project charter before planning starts.';
    await sync(
      user.token,
      { cursor: null, changes: [note(sentence, t0)] },
      api,
    );
    await sync(
      otherUser.token,
      { cursor: null, changes: [note(sentence, t0)] },
      api,
    );
    expect(calls).toHaveLength(2);
  });

  it('keeps a meaning the user typed', async () => {
    const { calls, api } = dictionary();
    const res = await sync(
      user.token,
      {
        cursor: null,
        changes: [note('float', t0, { meaning: 'độ trễ cho phép' })],
      },
      api,
    );
    expect(res.items[0].meaning).toBe('độ trễ cho phép');
    expect(calls).toEqual([]);
  });

  it('lets the newest change win and sends it back to the device that lost', async () => {
    await sync(user.token, {
      cursor: null,
      changes: [
        note('baseline', t0, { meaning: 'mốc chuẩn', updatedAt: t0 + 2000 }),
      ],
    });
    // An older change from another device, typed offline.
    const stale = await sync(user.token, {
      cursor: null,
      changes: [
        note('baseline', t0, { meaning: 'đường gốc', updatedAt: t0 + 1000 }),
      ],
    });
    expect(stale.items).toHaveLength(1);
    expect(stale.items[0]).toMatchObject({
      meaning: 'mốc chuẩn',
      updatedAt: t0 + 2000,
    });

    // A newer change without a meaning keeps the known one.
    const touched = await sync(user.token, {
      cursor: stale.cursor,
      changes: [note('Baseline', t0, { updatedAt: t0 + 3000, context: null })],
    });
    expect(touched.items[0]).toMatchObject({
      term: 'Baseline',
      meaning: 'mốc chuẩn',
      context: 'The baseline is reviewed.',
      updatedAt: t0 + 3000,
    });
  });

  it('spreads deletes to other devices, and revives notes with their meaning', async () => {
    const phone = await sync(user.token, {
      cursor: null,
      changes: [note('baseline', t0, { meaning: 'đường cơ sở' })],
    });
    const web = await sync(user.token, { cursor: null, changes: [] });
    expect(web.items).toHaveLength(1);

    await sync(user.token, {
      cursor: phone.cursor,
      changes: [
        note('baseline', t0, {
          meaning: 'đường cơ sở',
          deleted: true,
          updatedAt: t0 + 1000,
        }),
      ],
    });
    const webAfter = await sync(user.token, {
      cursor: web.cursor,
      changes: [],
    });
    expect(webAfter.items).toEqual([
      expect.objectContaining({ key: 'baseline', deleted: true }),
    ]);

    // A new device does not download deleted notes…
    const fresh = await sync(user.token, { cursor: null, changes: [] });
    expect(fresh.items).toEqual([]);
    // …unless it uploads one of them: it must learn that its older copy lost.
    const offline = await sync(user.token, {
      cursor: null,
      changes: [note('baseline', t0, { updatedAt: t0 + 500 })],
    });
    expect(offline.items).toEqual([
      expect.objectContaining({ key: 'baseline', deleted: true }),
    ]);

    // Noting it again later brings it back, meaning included.
    const revived = await sync(user.token, {
      cursor: webAfter.cursor,
      changes: [note('baseline', t0 + 2000, { updatedAt: t0 + 2000 })],
    });
    expect(revived.items[0]).toMatchObject({
      deleted: false,
      meaning: 'đường cơ sở',
    });
  });

  it('keeps notes private', async () => {
    await sync(user.token, { cursor: null, changes: [note('baseline', t0)] });
    const other = await sync(otherUser.token, { cursor: null, changes: [] });
    expect(other.items).toEqual([]);
    expect(other.maxRev).toBe(0);
  });

  it('reports notes it dropped or stored under another key', async () => {
    const res = await sync(user.token, {
      cursor: null,
      changes: [
        { ...note('...', t0), key: '...' },
        { ...note('Baseline,', t0), key: 'Baseline' },
      ],
    });
    expect(res.rejected).toEqual([
      { key: '...', code: 'INVALID_TERM' },
      { key: 'Baseline', code: 'REKEY', newKey: 'baseline' },
    ]);
    expect(res.items.map((item: Item) => [item.key, item.term])).toEqual([
      ['baseline', 'Baseline'],
    ]);
  });

  it('gives up after 3 unusable translations until the user asks again', async () => {
    const { calls, api } = translateWith(() => '');
    const body = { cursor: null, changes: [note('baseline', t0)] };
    await sync(user.token, body, api);
    await sync(user.token, { cursor: null, changes: [] }, api);
    const third = await sync(user.token, { cursor: null, changes: [] }, api);
    expect(third.items[0]).toMatchObject({
      meaning: null,
      translateFailed: true,
    });
    expect(third.pending).toBe(0);
    await sync(user.token, { cursor: null, changes: [] }, api);
    expect(calls).toHaveLength(3);

    // Uploading the note again (newer, still without a meaning) asks for a new translation.
    const retried = await sync(
      user.token,
      {
        cursor: null,
        changes: [note('baseline', t0, { updatedAt: t0 + 1000 })],
      },
      api,
    );
    expect(calls).toHaveLength(4);
    expect(retried.items[0]).toMatchObject({ translateFailed: false });
  });

  it('does not count outages as tries', async () => {
    // Rate limited, then the network gone: neither is the note's fault.
    let call = 0;
    const { calls, api } = translateWith(() =>
      (call += 1) % 2 === 1 ? 429 : new TypeError('fetch failed'),
    );
    for (let i = 0; i < 4; i += 1) {
      const res = await sync(
        user.token,
        { cursor: null, changes: i === 0 ? [note('baseline', t0)] : [] },
        api,
      );
      expect(res).toMatchObject({ pending: 1, translateUnavailable: true });
    }
    // Every engine and variant was tried at least once per sync.
    expect(calls.length).toBeGreaterThanOrEqual(4);
    const row = await ctx.db.$client
      .prepare('SELECT "translateTries" FROM "VocabNote" WHERE "userId" = ?')
      .bind(user.id)
      .first<{ translateTries: number }>();
    expect(row?.translateTries).toBe(0);
  });

  it('pages through large vocabularies', async () => {
    for (let batch = 0; batch < 5; batch += 1) {
      const changes = Array.from({ length: 50 }, (_, i) =>
        note(`term${batch * 50 + i}`, t0),
      );
      await sync(user.token, { cursor: null, changes });
    }
    const first = await sync(user.token, { cursor: null, changes: [] });
    expect(first.items).toHaveLength(200);
    expect(first.hasMore).toBe(true);
    const second = await sync(user.token, {
      cursor: first.cursor,
      changes: [],
    });
    expect(second.items).toHaveLength(50);
    expect(second.hasMore).toBe(false);
    const keys = new Set(
      [...first.items, ...second.items].map((item: Item) => item.key),
    );
    expect(keys.size).toBe(250);
    expect(second.maxRev).toBe(second.cursor.rev);
  });

  it('is rate limited per user', async () => {
    const limited = ctx.apiWith({
      VOCAB_LIMITER: { limit: async () => ({ success: false }) },
    });
    const res = await limited
      .post('/vocab/sync', user.token)
      .send({ cursor: null, changes: [] })
      .expect(429);
    expect(res.body.code).toBe('TOO_MANY_REQUESTS');
  });
});
