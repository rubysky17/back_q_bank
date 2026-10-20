import {
  createFreeTranslator,
  GOOGLE_VARIANTS,
  MICROSOFT_URL,
} from './translator';

const items = [
  { term: 'stakeholder', kind: 'WORD' as const },
  { term: 'R&D budget', kind: 'PHRASE' as const },
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
const blockedPage = () =>
  new Response('<html>Our systems have detected unusual traffic</html>', {
    status: 429,
  });

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

/** Stubs fetch; returns the URLs it was called with. */
function stubFetch(handler: Handler) {
  const urls: URL[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    urls.push(url);
    return handler(url, init ?? {});
  });
  return urls;
}

const isGoogle = (url: URL, client?: string) =>
  url.pathname === '/translate_a/t' &&
  (client === undefined || url.searchParams.get('client') === client);

describe('free translator', () => {
  let warn: typeof console.warn;
  beforeEach(() => {
    warn = console.warn;
    console.warn = () => {};
  });
  afterEach(() => {
    console.warn = warn;
    vi.restoreAllMocks();
  });

  it('translates every item with one Google request', async () => {
    let form: URLSearchParams | undefined;
    const urls = stubFetch((_url, init) => {
      form = init.body as URLSearchParams;
      return json([' bên liên quan ', 'ngân sách R&D']);
    });

    expect(await createFreeTranslator().translate(items)).toEqual([
      {
        status: 'ok',
        meaning: 'bên liên quan',
        partOfSpeech: null,
        explanation: null,
        engine: 'google',
      },
      {
        status: 'ok',
        meaning: 'ngân sách R&D',
        partOfSpeech: null,
        explanation: null,
        engine: 'google',
      },
    ]);
    expect(urls).toHaveLength(1);
    expect(urls[0]!.origin + urls[0]!.pathname).toBe(GOOGLE_VARIANTS[0].base);
    expect(Object.fromEntries(urls[0]!.searchParams)).toEqual({
      client: 'gtx',
      sl: 'en',
      tl: 'vi',
    });
    // "&" is escaped: the endpoint decodes HTML entities in its input.
    expect(form?.getAll('q')).toEqual(['stakeholder', 'R&amp;D budget']);
  });

  it('moves to the next Google variant when one is blocked, and stays there', async () => {
    const urls = stubFetch((url) =>
      isGoogle(url, 'gtx') ? blockedPage() : json(['a', 'b']),
    );
    const translator = createFreeTranslator();

    const first = await translator.translate(items);
    expect(first.map((result) => result.status)).toEqual(['ok', 'ok']);
    expect(urls.map((url) => url.searchParams.get('client'))).toEqual([
      'gtx',
      'dict-chrome-ex',
    ]);

    await translator.translate(items);
    // The blocked variant cools down; the one that worked goes first.
    expect(urls[2]!.searchParams.get('client')).toBe('dict-chrome-ex');
    expect(urls).toHaveLength(3);
  });

  it('falls back to Microsoft when Google refuses', async () => {
    let sent: unknown;
    const urls = stubFetch((url, init) => {
      if (isGoogle(url)) return blockedPage();
      sent = JSON.parse(String(init.body));
      return json([
        { translations: [{ text: 'bên liên quan', to: 'vi' }] },
        { translations: [{ text: 'ngân sách R&amp;D', to: 'vi' }] },
      ]);
    });

    const results = await createFreeTranslator().translate(items);
    expect(results).toMatchObject([
      { status: 'ok', meaning: 'bên liên quan', engine: 'microsoft' },
      { status: 'ok', meaning: 'ngân sách R&D', engine: 'microsoft' },
    ]);
    expect(urls).toHaveLength(GOOGLE_VARIANTS.length + 1);
    expect(urls.at(-1)!.origin + urls.at(-1)!.pathname).toBe(MICROSOFT_URL);
    expect(sent).toEqual(['stakeholder', 'R&amp;D budget']);
  });

  it('falls back when Google answers the wrong number of items', async () => {
    stubFetch((url) =>
      isGoogle(url)
        ? json(['only one'])
        : json([
            { translations: [{ text: 'một' }] },
            { translations: [{ text: 'hai' }] },
          ]),
    );
    const results = await createFreeTranslator().translate(items);
    expect(results).toMatchObject([
      { meaning: 'một', engine: 'microsoft' },
      { meaning: 'hai', engine: 'microsoft' },
    ]);
  });

  it('is unavailable when no engine answers', async () => {
    stubFetch(() => {
      throw new TypeError('fetch failed');
    });
    expect(await createFreeTranslator().translate(items)).toEqual([
      { status: 'unavailable' },
      { status: 'unavailable' },
    ]);
  });

  it('gives up on an endpoint after the timeout', async () => {
    stubFetch(
      (_url, init) =>
        new Promise((_, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason),
          );
        }),
    );
    expect(await createFreeTranslator(20).translate(items)).toEqual([
      { status: 'unavailable' },
      { status: 'unavailable' },
    ]);
  });

  it('marks empty translations as unusable', async () => {
    stubFetch(() => json(['  ', 'ngân sách']));
    expect(await createFreeTranslator().translate(items)).toMatchObject([
      { status: 'invalid' },
      { status: 'ok', meaning: 'ngân sách' },
    ]);
  });

  it('sends nothing without notes', async () => {
    const urls = stubFetch(() => json([]));
    expect(await createFreeTranslator().translate([])).toEqual([]);
    expect(urls).toHaveLength(0);
  });
});
