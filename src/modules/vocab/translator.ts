/**
 * English → Vietnamese translation for vocabulary notes, with the free key-less endpoints the
 * browsers' built-in translators use (same approach as translator_extension's
 * `extension/src/background/engines.js`): Google `translate_a/t` in three variants, and Microsoft
 * Edge's translator when Google refuses. They are not official APIs: they can rate-limit or change
 * without notice, so blocked variants cool down and the next one is tried.
 */
import type { VocabKind } from '../../db/schema';

export interface TranslateItem {
  term: string;
  kind: VocabKind;
}

/**
 * `invalid`: an engine answered, but with nothing usable (counts toward the 3 tries).
 * `unavailable`: no engine answered (blocked, timeout, outage): try again later for free.
 */
export type TranslateResult =
  | {
      status: 'ok';
      meaning: string;
      partOfSpeech: string | null;
      explanation: string | null;
      /** Engine that answered, stored with the shared cached translations. */
      engine: string;
    }
  | { status: 'invalid' }
  | { status: 'unavailable' };

/** Translates vocabulary notes from English to Vietnamese. */
export interface Translator {
  /** One result per item, in order; never throws. */
  translate(items: readonly TranslateItem[]): Promise<TranslateResult[]>;
}

/** Per endpoint call: worst case (every variant tried) stays far below the app's 30 s timeout. */
export const TRANSLATE_TIMEOUT_MS = 5_000;
const MAX_MEANING = 300;

export const GOOGLE_VARIANTS = [
  { base: 'https://translate.googleapis.com/translate_a/t', client: 'gtx' },
  {
    base: 'https://translate.googleapis.com/translate_a/t',
    client: 'dict-chrome-ex',
  },
  {
    base: 'https://clients5.google.com/translate_a/t',
    client: 'dict-chrome-ex',
  },
] as const;
export const MICROSOFT_URL =
  'https://edge.microsoft.com/translate/translatetext';

class TranslateError extends Error {
  constructor(
    message: string,
    /** The endpoint refuses us (rate limit, captcha, unreachable): let it cool down. */
    readonly blocked = false,
  ) {
    super(message);
  }
}

const httpError = (engine: string, status: number) =>
  new TranslateError(
    `${engine} HTTP ${status}`,
    status === 429 || status === 403 || status >= 500,
  );

/** The body as text; the timeout also covers reading it. */
async function fetchText(url: string, init: RequestInit, timeoutMs: number) {
  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return {
      ok: response.ok,
      status: response.status,
      body: await response.text(),
    };
  } catch (error) {
    throw new TranslateError(`network error (${String(error)})`, true);
  }
}

/** A rate-limited endpoint answers with an HTML "unusual traffic" page. */
function parseJson(body: string, engine: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new TranslateError(`${engine}: unexpected response`, true);
  }
}

/** Remembers which variant worked last and cools down the blocked ones (15 s, doubling to 8 min). */
function rotation(size: number) {
  const cooldownUntil = new Array<number>(size).fill(0);
  const penalty = new Array<number>(size).fill(0);
  let preferred = 0;
  return {
    /** False while every variant is cooling down. */
    available: () => cooldownUntil.some((until) => until <= Date.now()),
    order() {
      const now = Date.now();
      const all = [...Array(size).keys()];
      const ready = all
        .filter((i) => cooldownUntil[i]! <= now)
        .sort((a, b) => (a === preferred ? -1 : b === preferred ? 1 : a - b));
      // Everything cooling down: still try the one that frees up first.
      if (ready.length === 0) {
        return all
          .sort((a, b) => cooldownUntil[a]! - cooldownUntil[b]!)
          .slice(0, 1);
      }
      return ready;
    },
    success(i: number) {
      preferred = i;
      penalty[i] = 0;
      cooldownUntil[i] = 0;
    },
    blocked(i: number) {
      penalty[i] = Math.min(penalty[i]! + 1, 6);
      cooldownUntil[i] = Date.now() + 15_000 * 2 ** (penalty[i]! - 1);
    },
  };
}

type Rotation = ReturnType<typeof rotation>;

async function tryVariants<V, T>(
  variants: readonly V[],
  rot: Rotation,
  run: (variant: V) => Promise<T>,
): Promise<T> {
  let lastError: unknown = new TranslateError('no variant');
  for (const i of rot.order()) {
    try {
      const out = await run(variants[i]!);
      rot.success(i);
      return out;
    } catch (error) {
      lastError = error;
      if (error instanceof TranslateError && error.blocked) rot.blocked(i);
      // Anything else (a variant that changed shape): still try the others.
    }
  }
  throw lastError;
}

interface Engine {
  id: string;
  available(): boolean;
  translate(texts: string[]): Promise<string[]>;
}

function googleEngine(timeoutMs: number): Engine {
  const rot = rotation(GOOGLE_VARIANTS.length);
  return {
    id: 'google',
    available: rot.available,
    translate: (texts) =>
      tryVariants(GOOGLE_VARIANTS, rot, async ({ base, client }) => {
        const body = new URLSearchParams();
        // The endpoint decodes HTML entities in its input but returns plain text: escape "&" only.
        for (const text of texts) body.append('q', text.replace(/&/g, '&amp;'));
        const res = await fetchText(
          `${base}?client=${client}&sl=en&tl=vi`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
            },
            body,
          },
          timeoutMs,
        );
        if (!res.ok) throw httpError('Google', res.status);
        const data = parseJson(res.body, 'Google');
        // ["t1", "t2"] with a fixed source language; [["t1", "en"], …] with sl=auto.
        const items = Array.isArray(data) ? data : [data];
        if (items.length !== texts.length) {
          throw new TranslateError('Google: result count mismatch');
        }
        return items.map((item: unknown) =>
          String((Array.isArray(item) ? item[0] : item) ?? ''),
        );
      }),
  };
}

// Edge's tag aligner eats bare "<" and "&": escape them, decode the result.
const escapeMarkup = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unescapeMarkup = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');

function microsoftEngine(timeoutMs: number): Engine {
  const rot = rotation(1);
  return {
    id: 'microsoft',
    available: rot.available,
    translate: (texts) =>
      tryVariants([MICROSOFT_URL], rot, async (base) => {
        const res = await fetchText(
          `${base}?from=en&to=vi&isEnterpriseClient=false`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(texts.map(escapeMarkup)),
          },
          timeoutMs,
        );
        if (!res.ok) throw httpError('Microsoft', res.status);
        const data = parseJson(res.body, 'Microsoft');
        if (!Array.isArray(data) || data.length !== texts.length) {
          throw new TranslateError('Microsoft: result count mismatch');
        }
        return data.map((item: { translations?: { text?: unknown }[] }) =>
          unescapeMarkup(String(item?.translations?.[0]?.text ?? '')),
        );
      }),
  };
}

/**
 * Google first, Microsoft when Google fails. The rotation state lives as long as the isolate, so
 * a blocked variant stays skipped across requests.
 */
export function createFreeTranslator(
  timeoutMs = TRANSLATE_TIMEOUT_MS,
): Translator {
  const engines = [googleEngine(timeoutMs), microsoftEngine(timeoutMs)];
  return {
    async translate(items) {
      if (items.length === 0) return [];
      const texts = items.map((item) => item.term);
      const ready = engines.filter((engine) => engine.available());
      for (const engine of ready.length > 0 ? ready : engines.slice(0, 1)) {
        try {
          const translations = await engine.translate(texts);
          return translations.map((text): TranslateResult => {
            const meaning = text
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, MAX_MEANING);
            return meaning
              ? {
                  status: 'ok',
                  meaning,
                  partOfSpeech: null,
                  explanation: null,
                  engine: engine.id,
                }
              : { status: 'invalid' };
          });
        } catch (error) {
          console.warn(
            `[vocab] ${engine.id} translation failed`,
            String(error),
          );
        }
      }
      return items.map(() => ({ status: 'unavailable' }));
    },
  };
}

/** The Worker's translator (one per isolate, so it remembers blocked endpoints). */
export const freeTranslator = createFreeTranslator();
