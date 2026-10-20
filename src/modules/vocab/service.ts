import { type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { batch, type Db } from '../../db/client';
import type { VocabKind } from '../../db/schema';
import type { AuthUser } from '../../lib/access';
import {
  classifyKind,
  isValidTerm,
  MAX_CONTEXT_LENGTH,
  normalizeTerm,
  termKey,
} from './term';
import type { Translator } from './translator';

/** Changes per request: keeps the body far below the 100 kB limit and the CPU in budget. */
export const VOCAB_PUSH_LIMIT = 50;
/** Notes returned per request; the app asks again while `hasMore`. */
export const VOCAB_PAGE_SIZE = 200;
/** Notes translated per request (the app syncs again while `pending` goes down). */
const TRANSLATE_BATCH = 5;
/** Unusable translations before the server gives up (until the user asks again). */
export const MAX_TRANSLATE_TRIES = 3;
const MAX_MEANING = 300;
const MAX_EXPLANATION = 400;
const MAX_PART_OF_SPEECH = 30;
const MAX_SOURCE_TITLE = 120;

const ms = () => z.number().int().min(0);
const optionalText = (max: number) => z.string().max(max).nullish();

/**
 * What the app uploads: its notes changed since the last acknowledged sync, and the cursor of the
 * last page it received (null for a first sync). Fields over the stored limits are clipped, not
 * refused, so one odd note never blocks the others.
 */
export const syncVocabSchema = z.strictObject({
  cursor: z
    .strictObject({ rev: z.number().int().min(0), key: z.string().max(1000) })
    .nullable(),
  changes: z
    .array(
      z.strictObject({
        /** `termKey(term)` as the app computed it; the server's own wins (see `rejected`). */
        key: z.string().max(1000),
        term: z.string().max(1000),
        meaning: optionalText(1000),
        partOfSpeech: optionalText(100),
        explanation: optionalText(1000),
        context: optionalText(2000),
        sourceTitle: optionalText(500),
        deleted: z.boolean(),
        createdAt: ms(),
        /** Device clock of the change: the newest change wins, field by field. */
        updatedAt: ms(),
      }),
    )
    .max(VOCAB_PUSH_LIMIT),
});

export type SyncVocabInput = z.infer<typeof syncVocabSchema>;

export interface VocabItem {
  key: string;
  term: string;
  kind: VocabKind;
  meaning: string | null;
  partOfSpeech: string | null;
  explanation: string | null;
  context: string | null;
  sourceTitle: string | null;
  deleted: boolean;
  /** No meaning after `MAX_TRANSLATE_TRIES` attempts: the app offers to type it or to retry. */
  translateFailed: boolean;
  createdAt: number;
  updatedAt: number;
}

/** INVALID_TERM: dropped (no word, too long). REKEY: stored under `newKey`, the app should move it. */
export interface RejectedChange {
  key: string;
  code: 'INVALID_TERM' | 'REKEY';
  newKey?: string;
}

export interface VocabCursor {
  rev: number;
  key: string;
}

interface NoteRow {
  key: string;
  term: string;
  kind: VocabKind;
  meaning: string | null;
  partOfSpeech: string | null;
  explanation: string | null;
  context: string | null;
  sourceTitle: string | null;
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface PendingRow {
  termKey: string;
  term: string;
  kind: VocabKind;
}

interface PulledRow {
  termKey: string;
  term: string;
  kind: VocabKind;
  meaning: string | null;
  partOfSpeech: string | null;
  explanation: string | null;
  context: string | null;
  sourceTitle: string | null;
  deletedAt: number | null;
  translateTries: number;
  rev: number;
  createdAt: number;
  clientUpdatedAt: number;
}

const clip = (value: string | null | undefined, max: number) => {
  const text = value?.replace(/\s+/g, ' ').trim() ?? '';
  return text === '' ? null : text.slice(0, max);
};

/**
 * Offline-first sync of the user's vocabulary. One D1 round trip stores the uploaded changes (last
 * write wins per field), fills meanings from the shared translation cache, picks up to 5 notes
 * still waiting for a translation and reads the page after `cursor`. Only when there is something
 * to translate, a second one stores what the translator returned and reads the notes changed meanwhile.
 *
 * Every write gives the row `rev = max(rev) + 1` inside SQL; D1 runs statements one at a time, so
 * a page read never misses a row written later. Every uploaded note gets a new `rev` even when an
 * older change loses, so the app always receives the state that won.
 */
export async function syncVocab(
  db: Db,
  /** Undefined: notes are kept and synced, untranslated. */
  translator: Translator | undefined,
  user: AuthUser,
  input: SyncVocabInput,
) {
  const now = Date.now();
  const userId = user.id;
  const { rows, rejected } = prepareChanges(input.changes, now);
  const pushedKeys = rows.map((row) => row.key);
  const nextRev = sql`(SELECT coalesce(max("rev"), 0) + 1 FROM "VocabNote" WHERE "userId" = ${userId})`;

  const first = [];
  if (rows.length > 0) {
    first.push(
      upsertNotes(db, userId, rows, nextRev, now),
      db.run(sql`
        UPDATE "VocabNote" SET
          "meaning" = t."meaning", "partOfSpeech" = t."partOfSpeech", "explanation" = t."explanation",
          "rev" = ${nextRev}, "updatedAt" = ${now}
        FROM "TermTranslation" AS t
        WHERE "VocabNote"."userId" = ${userId} AND "VocabNote"."termKey" = t."termKey"
          AND "VocabNote"."meaning" IS NULL AND "VocabNote"."deletedAt" IS NULL
          AND "VocabNote"."kind" <> 'SENTENCE'`),
    );
  }
  first.push(
    db.run(sql`
      SELECT "termKey", "term", "kind" FROM "VocabNote"
      WHERE "userId" = ${userId} AND "meaning" IS NULL AND "deletedAt" IS NULL
        AND "translateTries" < ${MAX_TRANSLATE_TRIES}
      ORDER BY "rev" DESC LIMIT ${translator ? TRANSLATE_BATCH : 0}`),
    pullAfter(db, userId, input.cursor, pushedKeys),
    readStats(db, userId),
  );
  const firstResults = await batch(db, first);
  const pending = firstResults.at(-3)!.results as PendingRow[];
  let pulled = firstResults.at(-2)!.results as PulledRow[];
  let stats = firstResults.at(-1)!.results[0] as Stats;

  let page = pulled.slice(0, VOCAB_PAGE_SIZE);
  let hasMore = pulled.length > VOCAB_PAGE_SIZE;
  let cursor = page.length > 0 ? cursorOf(page.at(-1)!) : input.cursor;
  // Without a translator nothing is selected above; say so, so the app stops waiting.
  let translateUnavailable = !translator && stats.pending > 0;

  if (translator && pending.length > 0) {
    const results = await translator.translate(
      pending.map((row) => ({ term: row.term, kind: row.kind })),
    );
    const translated = [];
    const unusable = [];
    for (const [index, result] of results.entries()) {
      const row = pending[index];
      if (result.status === 'ok') {
        translated.push({
          key: row.termKey,
          kind: row.kind,
          meaning: result.meaning,
          partOfSpeech: result.partOfSpeech,
          explanation: result.explanation,
          engine: result.engine,
        });
      } else if (result.status === 'invalid') {
        unusable.push(row.termKey);
      } else {
        translateUnavailable = true;
      }
    }
    const second = [];
    if (translated.length > 0) {
      second.push(
        db.run(sql`
          UPDATE "VocabNote" SET
            "meaning" = v."meaning", "partOfSpeech" = v."partOfSpeech", "explanation" = v."explanation",
            "rev" = ${nextRev}, "updatedAt" = ${now}
          FROM (SELECT value ->> 'key' AS "key", value ->> 'meaning' AS "meaning",
                       value ->> 'partOfSpeech' AS "partOfSpeech", value ->> 'explanation' AS "explanation"
                FROM json_each(${JSON.stringify(translated)})) AS v
          WHERE "VocabNote"."userId" = ${userId} AND "VocabNote"."termKey" = v."key"
            AND "VocabNote"."meaning" IS NULL`),
      );
      const cacheable = translated.filter((row) => row.kind !== 'SENTENCE');
      if (cacheable.length > 0) {
        second.push(
          db.run(sql`
            INSERT INTO "TermTranslation" ("termKey", "meaning", "partOfSpeech", "explanation", "model", "createdAt")
            SELECT value ->> 'key', value ->> 'meaning', value ->> 'partOfSpeech', value ->> 'explanation',
                   value ->> 'engine', ${now}
            FROM json_each(${JSON.stringify(cacheable)})
            WHERE true
            ON CONFLICT ("termKey") DO NOTHING`),
        );
      }
    }
    if (unusable.length > 0) {
      second.push(
        db.run(sql`
          UPDATE "VocabNote" SET
            "translateTries" = "translateTries" + 1, "rev" = ${nextRev}, "updatedAt" = ${now}
          WHERE "userId" = ${userId} AND "meaning" IS NULL
            AND "termKey" IN (SELECT value FROM json_each(${JSON.stringify(unusable)}))`),
      );
    }
    if (second.length > 0) {
      // A full page already makes the app ask again; otherwise hand over the notes just
      // translated (and anything another device wrote meanwhile) in this same response.
      if (!hasMore) second.push(pullAfter(db, userId, cursor, pushedKeys));
      second.push(readStats(db, userId));
      const secondResults = await batch(db, second);
      stats = secondResults.at(-1)!.results[0] as Stats;
      if (!hasMore) {
        pulled = secondResults.at(-2)!.results as PulledRow[];
        const delta = pulled.slice(0, VOCAB_PAGE_SIZE);
        const changed = new Set(delta.map((row) => row.termKey));
        page = [...page.filter((row) => !changed.has(row.termKey)), ...delta];
        hasMore = pulled.length > VOCAB_PAGE_SIZE;
        if (delta.length > 0) cursor = cursorOf(delta.at(-1)!);
      }
    }
  }

  return {
    items: page.map(toItem),
    cursor,
    hasMore,
    /** Notes still waiting for a translation (the app syncs again while it goes down). */
    pending: stats.pending,
    /** Highest rev stored: a cursor above it comes from a restored database and must restart. */
    maxRev: stats.maxRev,
    /** The translator did not answer (no key, quota, outage): stop waiting until the next sync. */
    translateUnavailable,
    rejected,
    serverTime: new Date(now),
  };
}

interface Stats {
  pending: number;
  maxRev: number;
}

const cursorOf = (row: PulledRow): VocabCursor => ({
  rev: row.rev,
  key: row.termKey,
});

/**
 * The page after `cursor`, oldest change first. A first sync (no cursor) skips deleted notes,
 * except those it just uploaded: it must learn that its copy lost.
 */
function pullAfter(
  db: Db,
  userId: string,
  cursor: VocabCursor | null,
  pushedKeys: string[],
) {
  const after = cursor
    ? sql`("rev", "termKey") > (${cursor.rev}, ${cursor.key})`
    : pushedKeys.length > 0
      ? sql`("deletedAt" IS NULL OR "termKey" IN (SELECT value FROM json_each(${JSON.stringify(pushedKeys)})))`
      : sql`"deletedAt" IS NULL`;
  return db.run(sql`
    SELECT "termKey", "term", "kind", "meaning", "partOfSpeech", "explanation", "context",
           "sourceTitle", "deletedAt", "translateTries", "rev", "createdAt", "clientUpdatedAt"
    FROM "VocabNote"
    WHERE "userId" = ${userId} AND ${after}
    ORDER BY "rev", "termKey" LIMIT ${VOCAB_PAGE_SIZE + 1}`);
}

function readStats(db: Db, userId: string) {
  return db.run(sql`
    SELECT
      (SELECT count(*) FROM "VocabNote" WHERE "userId" = ${userId} AND "meaning" IS NULL
         AND "deletedAt" IS NULL AND "translateTries" < ${MAX_TRANSLATE_TRIES}) AS "pending",
      (SELECT coalesce(max("rev"), 0) FROM "VocabNote" WHERE "userId" = ${userId}) AS "maxRev"`);
}

/** Validates, normalises and de-duplicates the uploaded changes (the newest per key wins). */
function prepareChanges(changes: SyncVocabInput['changes'], now: number) {
  const rejected: RejectedChange[] = [];
  const byKey = new Map<string, NoteRow>();
  for (const change of changes) {
    const term = normalizeTerm(change.term);
    if (!isValidTerm(term)) {
      rejected.push({ key: change.key, code: 'INVALID_TERM' });
      continue;
    }
    const key = termKey(term);
    if (key !== change.key) {
      rejected.push({ key: change.key, code: 'REKEY', newKey: key });
    }
    // A clock in the future would win every later conflict.
    const updatedAt = Math.min(change.updatedAt, now);
    const previous = byKey.get(key);
    if (previous && previous.updatedAt > updatedAt) continue;
    const meaning = clip(change.meaning, MAX_MEANING);
    byKey.set(key, {
      key,
      term,
      kind: classifyKind(term),
      meaning,
      partOfSpeech: meaning
        ? clip(change.partOfSpeech, MAX_PART_OF_SPEECH)
        : null,
      explanation: meaning ? clip(change.explanation, MAX_EXPLANATION) : null,
      context: clip(change.context, MAX_CONTEXT_LENGTH),
      sourceTitle: clip(change.sourceTitle, MAX_SOURCE_TITLE),
      deletedAt: change.deleted ? updatedAt : null,
      createdAt: Math.min(change.createdAt, updatedAt),
      updatedAt,
    });
  }
  return { rows: [...byKey.values()], rejected };
}

/**
 * Inserts or merges the uploaded notes. When both sides changed, the newer change (device clock)
 * wins field by field, but a known meaning, context or source is never replaced by nothing.
 * Uploading a note with no meaning again resets its tries: that is how the app asks for a retry.
 */
function upsertNotes(
  db: Db,
  userId: string,
  rows: NoteRow[],
  nextRev: SQL,
  now: number,
) {
  const newer = sql.raw(
    `excluded."clientUpdatedAt" >= "VocabNote"."clientUpdatedAt"`,
  );
  const takeMeaning =
    sql.raw(`(CASE WHEN excluded."clientUpdatedAt" >= "VocabNote"."clientUpdatedAt"
      THEN excluded."meaning" IS NOT NULL
      ELSE "VocabNote"."meaning" IS NULL AND excluded."meaning" IS NOT NULL END)`);
  const keep = (column: string) =>
    sql.raw(`CASE WHEN excluded."clientUpdatedAt" >= "VocabNote"."clientUpdatedAt"
      THEN coalesce(excluded."${column}", "VocabNote"."${column}")
      ELSE coalesce("VocabNote"."${column}", excluded."${column}") END`);
  return db.run(sql`
    INSERT INTO "VocabNote" ("userId", "termKey", "term", "kind", "meaning", "partOfSpeech",
      "explanation", "context", "sourceTitle", "translateTries", "clientUpdatedAt", "rev", "deletedAt",
      "createdAt", "updatedAt")
    SELECT ${userId}, value ->> 'key', value ->> 'term', value ->> 'kind', value ->> 'meaning',
      value ->> 'partOfSpeech', value ->> 'explanation', value ->> 'context', value ->> 'sourceTitle', 0,
      value ->> 'updatedAt', ${nextRev}, value ->> 'deletedAt', value ->> 'createdAt', ${now}
    FROM json_each(${JSON.stringify(rows)})
    WHERE true
    ON CONFLICT ("userId", "termKey") DO UPDATE SET
      "term" = CASE WHEN ${newer} THEN excluded."term" ELSE "VocabNote"."term" END,
      "kind" = CASE WHEN ${newer} THEN excluded."kind" ELSE "VocabNote"."kind" END,
      "meaning" = CASE WHEN ${takeMeaning} THEN excluded."meaning" ELSE "VocabNote"."meaning" END,
      "partOfSpeech" = CASE WHEN ${takeMeaning} THEN excluded."partOfSpeech" ELSE "VocabNote"."partOfSpeech" END,
      "explanation" = CASE WHEN ${takeMeaning} THEN excluded."explanation" ELSE "VocabNote"."explanation" END,
      "context" = ${keep('context')},
      "sourceTitle" = ${keep('sourceTitle')},
      "translateTries" = CASE WHEN ${newer} AND excluded."meaning" IS NULL AND "VocabNote"."meaning" IS NULL
                              THEN 0 ELSE "VocabNote"."translateTries" END,
      "deletedAt" = CASE WHEN ${newer} THEN excluded."deletedAt" ELSE "VocabNote"."deletedAt" END,
      "clientUpdatedAt" = max(excluded."clientUpdatedAt", "VocabNote"."clientUpdatedAt"),
      "createdAt" = min(excluded."createdAt", "VocabNote"."createdAt"),
      "rev" = excluded."rev",
      "updatedAt" = excluded."updatedAt"`);
}

function toItem(row: PulledRow): VocabItem {
  return {
    key: row.termKey,
    term: row.term,
    kind: row.kind,
    meaning: row.meaning,
    partOfSpeech: row.partOfSpeech,
    explanation: row.explanation,
    context: row.context,
    sourceTitle: row.sourceTitle,
    deleted: row.deletedAt !== null,
    translateFailed:
      row.meaning === null && row.translateTries >= MAX_TRANSLATE_TRIES,
    createdAt: row.createdAt,
    updatedAt: row.clientUpdatedAt,
  };
}
