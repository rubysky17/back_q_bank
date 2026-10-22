import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { batch, type Db } from '../../db/client';
import type { UserItemKind } from '../../db/schema';
import type { AuthUser } from '../../lib/access';
import { parseJson } from '../attempts/service';

/** Changes per request: keeps the body far below the 100 kB limit and the CPU in budget. */
export const USER_STATE_PUSH_LIMIT = 200;
/** Items returned per request; the app asks again while `hasMore`. */
export const USER_STATE_PAGE_SIZE = 200;
/** Longest stored value (JSON text): a drag-and-drop answer on a big question stays far below. */
const MAX_VALUE_LENGTH = 4000;

/** Account settings every device shares (theme stays per device). */
export const SETTING_KEYS = ['language', 'dailyGoal', 'reminder'] as const;

const settingValues = {
  language: z.enum(['system', 'vi', 'en']),
  dailyGoal: z.number().int().min(1).max(1000).nullable(),
  reminder: z.strictObject({
    enabled: z.boolean(),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  }),
} satisfies Record<(typeof SETTING_KEYS)[number], z.ZodType>;

/** What the user did on a question-bank question: the answer picked and whether they checked it. */
const practiceValue = z.strictObject({
  response: z.record(z.string(), z.unknown()).nullable(),
  checked: z.boolean(),
});

const ms = () => z.number().int().min(0);

/**
 * What the app uploads: its items changed since the last acknowledged sync, and the cursor of the
 * last page it received (null for a first sync). A value that does not fit its kind is refused
 * one by one (`rejected`), so one odd item never blocks the others.
 */
export const syncUserStateSchema = z.strictObject({
  cursor: z
    .strictObject({
      rev: z.number().int().min(0),
      kind: z.string().max(20),
      key: z.string().max(200),
    })
    .nullable(),
  changes: z
    .array(
      z.strictObject({
        kind: z.string().max(20),
        key: z.string().max(200),
        /** null with `deleted`. */
        value: z.unknown(),
        deleted: z.boolean(),
        /** Device clock of the change: the newest change wins. */
        updatedAt: ms(),
      }),
    )
    .max(USER_STATE_PUSH_LIMIT),
});

export type SyncUserStateInput = z.infer<typeof syncUserStateSchema>;

export interface UserStateCursor {
  rev: number;
  kind: string;
  key: string;
}

export interface UserStateItem {
  kind: UserItemKind;
  key: string;
  value: unknown;
  deleted: boolean;
  updatedAt: number;
}

export interface RejectedItem {
  kind: string;
  key: string;
  code: 'INVALID_ITEM';
}

interface ItemRow {
  kind: UserItemKind;
  key: string;
  value: string | null;
  deletedAt: number | null;
  updatedAt: number;
}

interface PulledRow {
  kind: UserItemKind;
  key: string;
  value: string | null;
  deletedAt: number | null;
  rev: number;
  clientUpdatedAt: number;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The value as stored (JSON text), or null when it does not fit the kind and key. */
function validValue(kind: string, key: string, value: unknown): string | null {
  let parsed: z.ZodSafeParseResult<unknown>;
  if (kind === 'PRACTICE') {
    if (!UUID_RE.test(key)) return null;
    parsed = practiceValue.safeParse(value);
  } else if (kind === 'SETTING') {
    if (!Object.hasOwn(settingValues, key)) return null;
    parsed = settingValues[key as keyof typeof settingValues].safeParse(value);
  } else {
    return null;
  }
  if (!parsed.success) return null;
  const text = JSON.stringify(parsed.data);
  return text.length <= MAX_VALUE_LENGTH ? text : null;
}

const isKnownKind = (kind: string): kind is UserItemKind =>
  kind === 'PRACTICE' || kind === 'SETTING';

/**
 * Offline-first sync of the user's practice answers and account settings, in one D1 round trip:
 * stores the uploaded changes (last write wins on the device clock) and reads the page after
 * `cursor`. Every uploaded item gets a new `rev` even when an older change loses, so the app always
 * receives the state that won (same rules as `syncVocab`).
 */
export async function syncUserState(
  db: Db,
  user: AuthUser,
  input: SyncUserStateInput,
) {
  const now = Date.now();
  const userId = user.id;
  const { rows, rejected } = prepareChanges(input.changes, now);
  const pushed = rows.map((row) => `${row.kind}:${row.key}`);

  const statements = [];
  if (rows.length > 0) statements.push(upsertItems(db, userId, rows, now));
  statements.push(
    pullAfter(db, userId, input.cursor, pushed),
    db.run(sql`
      SELECT coalesce(max("rev"), 0) AS "maxRev" FROM "UserItem" WHERE "userId" = ${userId}`),
  );
  const results = await batch(db, statements);
  const pulled = results.at(-2)!.results as PulledRow[];
  const { maxRev } = results.at(-1)!.results[0] as { maxRev: number };

  const page = pulled.slice(0, USER_STATE_PAGE_SIZE);
  const last = page.at(-1);
  return {
    items: page.map(toItem),
    cursor: last
      ? { rev: last.rev, kind: last.kind, key: last.key }
      : input.cursor,
    hasMore: pulled.length > USER_STATE_PAGE_SIZE,
    /** Highest rev stored: a cursor above it comes from a restored database and must restart. */
    maxRev,
    rejected,
    serverTime: new Date(now),
  };
}

/**
 * What changed for the user, in one cheap query: the apps poll it while open and sync only what
 * moved (practice and settings, vocabulary, attempts).
 */
export async function syncStatus(db: Db, user: AuthUser) {
  const [row] = (
    await batch(db, [
      db.run(sql`
        SELECT
          (SELECT coalesce(max("rev"), 0) FROM "UserItem" WHERE "userId" = ${user.id}) AS "userStateRev",
          (SELECT coalesce(max("rev"), 0) FROM "VocabNote" WHERE "userId" = ${user.id}) AS "vocabRev",
          (SELECT coalesce(max("updatedAt"), 0) FROM "Attempt" WHERE "userId" = ${user.id}) AS "attemptsUpdatedAt"`),
    ])
  )[0].results as {
    userStateRev: number;
    vocabRev: number;
    attemptsUpdatedAt: number;
  }[];
  return { ...row, serverTime: new Date() };
}

/** Validates the uploaded changes and keeps the newest per item. */
function prepareChanges(changes: SyncUserStateInput['changes'], now: number) {
  const rejected: RejectedItem[] = [];
  const byKey = new Map<string, ItemRow>();
  for (const change of changes) {
    const { kind, key } = change;
    const value = change.deleted ? null : validValue(kind, key, change.value);
    if (!isKnownKind(kind) || (!change.deleted && value === null)) {
      rejected.push({ kind, key, code: 'INVALID_ITEM' });
      continue;
    }
    // A clock in the future would win every later conflict.
    const updatedAt = Math.min(change.updatedAt, now);
    const id = `${kind}:${key}`;
    const previous = byKey.get(id);
    if (previous && previous.updatedAt > updatedAt) continue;
    byKey.set(id, {
      kind,
      key,
      value,
      deletedAt: change.deleted ? updatedAt : null,
      updatedAt,
    });
  }
  return { rows: [...byKey.values()], rejected };
}

/**
 * The page after `cursor`, oldest change first. A first sync (no cursor) skips deleted items,
 * except those it just uploaded: it must learn that its copy lost.
 */
function pullAfter(
  db: Db,
  userId: string,
  cursor: UserStateCursor | null,
  pushed: string[],
) {
  const after = cursor
    ? sql`("rev", "kind", "key") > (${cursor.rev}, ${cursor.kind}, ${cursor.key})`
    : pushed.length > 0
      ? sql`("deletedAt" IS NULL OR "kind" || ':' || "key" IN (SELECT value FROM json_each(${JSON.stringify(pushed)})))`
      : sql`"deletedAt" IS NULL`;
  return db.run(sql`
    SELECT "kind", "key", "value", "deletedAt", "rev", "clientUpdatedAt"
    FROM "UserItem"
    WHERE "userId" = ${userId} AND ${after}
    ORDER BY "rev", "kind", "key" LIMIT ${USER_STATE_PAGE_SIZE + 1}`);
}

/** Inserts or replaces the uploaded items; an older change keeps the stored one but bumps `rev`. */
function upsertItems(db: Db, userId: string, rows: ItemRow[], now: number) {
  const nextRev = sql`(SELECT coalesce(max("rev"), 0) + 1 FROM "UserItem" WHERE "userId" = ${userId})`;
  const newer = sql.raw(
    `excluded."clientUpdatedAt" >= "UserItem"."clientUpdatedAt"`,
  );
  return db.run(sql`
    INSERT INTO "UserItem" ("userId", "kind", "key", "value", "clientUpdatedAt", "rev", "deletedAt",
      "createdAt", "updatedAt")
    SELECT ${userId}, value ->> 'kind', value ->> 'key', value ->> 'value', value ->> 'updatedAt',
      ${nextRev}, value ->> 'deletedAt', ${now}, ${now}
    FROM json_each(${JSON.stringify(rows)})
    WHERE true
    ON CONFLICT ("userId", "kind", "key") DO UPDATE SET
      "value" = CASE WHEN ${newer} THEN excluded."value" ELSE "UserItem"."value" END,
      "deletedAt" = CASE WHEN ${newer} THEN excluded."deletedAt" ELSE "UserItem"."deletedAt" END,
      "clientUpdatedAt" = max(excluded."clientUpdatedAt", "UserItem"."clientUpdatedAt"),
      "rev" = excluded."rev",
      "updatedAt" = excluded."updatedAt"`);
}

function toItem(row: PulledRow): UserStateItem {
  return {
    kind: row.kind,
    key: row.key,
    value: row.value === null ? null : parseJson(row.value),
    deleted: row.deletedAt !== null,
    updatedAt: row.clientUpdatedAt,
  };
}
