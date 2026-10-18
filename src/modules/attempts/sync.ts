import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { batch, type Db } from '../../db/client';
import {
  ATTEMPT_EVENT_TYPES,
  ATTEMPT_PHASES,
  ATTEMPT_SECTION_STATUSES,
  attemptQuestions,
  attemptSections,
  CONFIDENCE_LEVELS,
  SECTION_END_REASONS,
} from '../../db/schema';
import type { AuthUser } from '../../lib/access';
import { AppError } from '../../lib/app-error';
import { inList } from '../../lib/sql';
import { zId } from '../../lib/validation';
import { getQuestionTypeHandler } from '../questions/question-types';
import { closedError, findOwned, snapshotField } from './service';

const ms = () => z.number().int().min(0);
const response = () => z.record(z.string(), z.unknown()).nullable();

/**
 * What the app uploads for a SECTIONED attempt: new events (in `seq` order) and its current state as
 * of `lastSeq`, the highest seq it has recorded. The app is the source of truth while the attempt is
 * open: it keeps the section clocks (paused while the user is away) and works offline.
 */
export const syncAttemptSchema = z.strictObject({
  lastSeq: z.number().int().min(0),
  phase: z.enum(ATTEMPT_PHASES),
  currentSectionOrder: z.number().int().min(1),
  events: z
    .array(
      z.strictObject({
        /** Made by the app (UUIDv7): uploading an event twice stores it once. */
        id: zId(),
        seq: z.number().int().min(1),
        type: z.enum(ATTEMPT_EVENT_TYPES),
        sectionOrder: z.number().int().min(1),
        attemptQuestionId: zId().nullish(),
        payload: z.record(z.string(), z.unknown()).nullish(),
        activeMs: ms(),
        clientAt: ms(),
      }),
    )
    .max(500),
  sections: z
    .array(
      z.strictObject({
        sectionOrder: z.number().int().min(1),
        usedMs: ms(),
        status: z.enum(ATTEMPT_SECTION_STATUSES),
        startedAt: ms().nullish(),
        endedAt: ms().nullish(),
        endReason: z.enum(SECTION_END_REASONS).nullish(),
        breakTakenMs: ms().nullish(),
        breakSkipped: z.boolean().nullish(),
      }),
    )
    .max(50),
  /** Only the questions that changed since the last acknowledged sync. */
  questions: z
    .array(
      z.strictObject({
        attemptQuestionId: zId(),
        response: response(),
        firstResponse: response(),
        flagged: z.boolean(),
        everFlagged: z.boolean(),
        confidence: z.enum(CONFIDENCE_LEVELS).nullable(),
        eliminatedOptionIds: z.array(z.string().max(100)).max(20),
        dwellMs: ms(),
        timeToFirstAnswerMs: ms().nullable(),
        timeToFinalAnswerMs: ms().nullable(),
        visitCount: ms(),
        answerChangeCount: ms(),
        eliminationCount: ms(),
      }),
    )
    .max(500),
});

type SyncAttemptInput = z.infer<typeof syncAttemptSchema>;

/** LOCKED < ACTIVE < COMPLETED: a section status never goes back. */
const rank = (column: string) =>
  sql.raw(
    `CASE ${column} WHEN 'LOCKED' THEN 0 WHEN 'ACTIVE' THEN 1 ELSE 2 END`,
  );

/**
 * Stores new events and the app's state in one atomic batch.
 *
 * - Events are taken in `seq` order without gaps, starting right after the stored `syncedSeq`; the
 *   rest waits for the next upload. The answer says up to where (`ackedSeq`).
 * - The state is applied only when it matches the stored events (`lastSeq === ackedSeq`), and never
 *   over a newer upload. Section clocks only move forward and never past their budget.
 * - A section closed by an earlier upload is final: later changes to its questions are ignored.
 *
 * The server cannot check time spent offline; these rules keep the data consistent, not cheat-proof.
 */
export async function syncAttempt(
  db: Db,
  user: AuthUser,
  attemptId: string,
  input: SyncAttemptInput,
) {
  const attempt = await findOwned(db, user, attemptId);
  if (attempt.mode !== 'SECTIONED') {
    throw AppError.conflict(
      'ATTEMPT_NOT_SECTIONED',
      'Only sectioned attempts are synced',
    );
  }
  if (attempt.status !== 'IN_PROGRESS') throw closedError();

  let ackedSeq = attempt.syncedSeq;
  const events: SyncAttemptInput['events'] = [];
  for (const event of [...input.events].sort((a, b) => a.seq - b.seq)) {
    if (event.seq <= attempt.syncedSeq) continue;
    if (event.seq !== ackedSeq + 1) break;
    events.push(event);
    ackedSeq = event.seq;
  }
  const applyState = input.lastSeq === ackedSeq;

  const sections = await db
    .select({
      sectionOrder: attemptSections.sectionOrder,
      budgetMs: attemptSections.budgetMs,
      status: attemptSections.status,
    })
    .from(attemptSections)
    .where(eq(attemptSections.attemptId, attemptId));
  const budgets = new Map(sections.map((s) => [s.sectionOrder, s.budgetMs]));
  const closedSections = new Set(
    sections.filter((s) => s.status === 'COMPLETED').map((s) => s.sectionOrder),
  );
  const budgetOf = (order: number) => {
    const budget = budgets.get(order);
    if (budget === undefined) {
      throw AppError.badRequest(
        'INVALID_SECTION',
        `Section ${order} is not part of this attempt`,
      );
    }
    return budget;
  };

  const questionIds = [
    ...new Set([
      ...events.flatMap((e) =>
        e.attemptQuestionId ? [e.attemptQuestionId] : [],
      ),
      ...(applyState ? input.questions.map((q) => q.attemptQuestionId) : []),
    ]),
  ];
  const known =
    questionIds.length === 0
      ? []
      : await db
          .select({
            id: attemptQuestions.id,
            sectionOrder: attemptQuestions.sectionOrder,
            type: snapshotField.type,
            data: snapshotField.data(),
          })
          .from(attemptQuestions)
          .where(
            and(
              eq(attemptQuestions.attemptId, attemptId),
              inList(attemptQuestions.id, questionIds),
            ),
          );
  const byId = new Map(known.map((q) => [q.id, q]));
  const unknown = questionIds.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    throw AppError.badRequest(
      'INVALID_ATTEMPT_QUESTION',
      `${unknown.length} question(s) do not belong to this attempt`,
      { attemptQuestionIds: unknown },
    );
  }

  const now = Date.now();
  const eventRows = events.map((event) => ({
    id: event.id,
    seq: event.seq,
    type: event.type,
    sectionOrder: event.sectionOrder,
    attemptQuestionId: event.attemptQuestionId ?? null,
    payload: event.payload ?? undefined,
    activeMs: Math.min(event.activeMs, budgetOf(event.sectionOrder)),
    clientAt: event.clientAt,
  }));

  const sectionRows = applyState
    ? input.sections.map((s) => ({
        sectionOrder: s.sectionOrder,
        usedMs: Math.min(s.usedMs, budgetOf(s.sectionOrder)),
        status: s.status,
        startedAt: s.startedAt ?? null,
        endedAt: s.endedAt ?? null,
        endReason: s.endReason ?? null,
        breakTakenMs: s.breakTakenMs ?? null,
        breakSkipped: s.breakSkipped ?? null,
      }))
    : [];

  const questionRows = applyState
    ? input.questions.flatMap((q) => {
        const stored = byId.get(q.attemptQuestionId)!;
        if (closedSections.has(stored.sectionOrder)) return [];
        const handler = getQuestionTypeHandler(stored.type);
        const parse = (value: Record<string, unknown> | null) =>
          value === null
            ? null
            : JSON.stringify(handler.parseResponse(stored.data, value));
        // Each time fits in the one before it, and all of them in the section budget.
        const dwellMs = Math.min(q.dwellMs, budgetOf(stored.sectionOrder));
        const toFinal =
          q.timeToFinalAnswerMs === null
            ? null
            : Math.min(q.timeToFinalAnswerMs, dwellMs);
        const toFirst =
          q.timeToFirstAnswerMs === null
            ? null
            : Math.min(q.timeToFirstAnswerMs, toFinal ?? dwellMs);
        return [
          {
            id: q.attemptQuestionId,
            response: parse(q.response),
            firstResponse: parse(q.firstResponse),
            flagged: q.flagged,
            everFlagged: q.everFlagged || q.flagged,
            confidence: q.confidence,
            eliminatedOptionIds: JSON.stringify(q.eliminatedOptionIds),
            dwellMs,
            timeToFirstAnswerMs: toFirst,
            timeToFinalAnswerMs: toFinal,
            visitCount: q.visitCount,
            answerChangeCount: q.answerChangeCount,
            eliminationCount: q.eliminationCount,
          },
        ];
      })
    : [];

  // Every write is guarded by "still in progress and not overtaken by a newer upload"; the Attempt
  // row moves syncedSeq last, so the guards of this batch read the value from before it.
  const open = sql`EXISTS (SELECT 1 FROM "Attempt" WHERE "Attempt"."id" = ${attemptId}
    AND "Attempt"."status" = 'IN_PROGRESS' AND "Attempt"."syncedSeq" <= ${ackedSeq})`;
  const statements = [];
  if (eventRows.length > 0) {
    statements.push(
      db.run(sql`
        INSERT OR IGNORE INTO "AttemptEvent" ("id", "attemptId", "seq", "type", "sectionOrder",
          "attemptQuestionId", "payload", "activeMs", "clientAt", "receivedAt")
        SELECT value ->> 'id', ${attemptId}, value ->> 'seq', value ->> 'type', value ->> 'sectionOrder',
          value ->> 'attemptQuestionId', value -> 'payload', value ->> 'activeMs', value ->> 'clientAt', ${now}
        FROM json_each(${JSON.stringify(eventRows)})
        WHERE ${open}`),
    );
  }
  if (questionRows.length > 0) {
    statements.push(
      db.run(sql`
        UPDATE "AttemptQuestion" SET
          "response" = v.response,
          "answeredAt" = CASE WHEN v.response IS NULL THEN NULL
                              WHEN "AttemptQuestion"."response" IS v.response
                                THEN coalesce("AttemptQuestion"."answeredAt", ${now})
                              ELSE ${now} END,
          "firstResponse" = v.firstResponse,
          "flagged" = v.flagged,
          "everFlagged" = v.everFlagged,
          "confidence" = v.confidence,
          "eliminatedOptionIds" = v.eliminatedOptionIds,
          "dwellMs" = v.dwellMs,
          "timeToFirstAnswerMs" = v.timeToFirstAnswerMs,
          "timeToFinalAnswerMs" = v.timeToFinalAnswerMs,
          "visitCount" = v.visitCount,
          "answerChangeCount" = v.answerChangeCount,
          "eliminationCount" = v.eliminationCount
        FROM (SELECT value ->> 'id' AS id, value ->> 'response' AS response,
                     value ->> 'firstResponse' AS firstResponse, value ->> 'flagged' AS flagged,
                     value ->> 'everFlagged' AS everFlagged, value ->> 'confidence' AS confidence,
                     value ->> 'eliminatedOptionIds' AS eliminatedOptionIds, value ->> 'dwellMs' AS dwellMs,
                     value ->> 'timeToFirstAnswerMs' AS timeToFirstAnswerMs,
                     value ->> 'timeToFinalAnswerMs' AS timeToFinalAnswerMs,
                     value ->> 'visitCount' AS visitCount, value ->> 'answerChangeCount' AS answerChangeCount,
                     value ->> 'eliminationCount' AS eliminationCount
              FROM json_each(${JSON.stringify(questionRows)})) AS v
        WHERE "AttemptQuestion"."id" = v.id AND "AttemptQuestion"."attemptId" = ${attemptId}
          AND NOT EXISTS (SELECT 1 FROM "AttemptSection" s WHERE s."attemptId" = ${attemptId}
                          AND s."sectionOrder" = "AttemptQuestion"."sectionOrder" AND s."status" = 'COMPLETED')
          AND ${open}`),
    );
  }
  if (sectionRows.length > 0) {
    statements.push(
      db.run(sql`
        UPDATE "AttemptSection" SET
          "usedMs" = max("AttemptSection"."usedMs", v.usedMs),
          "status" = CASE WHEN ${rank('v.status')} > ${rank('"AttemptSection"."status"')}
                          THEN v.status ELSE "AttemptSection"."status" END,
          "startedAt" = coalesce("AttemptSection"."startedAt", v.startedAt),
          "endedAt" = coalesce("AttemptSection"."endedAt", v.endedAt),
          "endReason" = coalesce("AttemptSection"."endReason", v.endReason),
          "breakTakenMs" = coalesce(v.breakTakenMs, "AttemptSection"."breakTakenMs"),
          "breakSkipped" = coalesce(v.breakSkipped, "AttemptSection"."breakSkipped")
        FROM (SELECT value ->> 'sectionOrder' AS sectionOrder, value ->> 'usedMs' AS usedMs,
                     value ->> 'status' AS status, value ->> 'startedAt' AS startedAt,
                     value ->> 'endedAt' AS endedAt, value ->> 'endReason' AS endReason,
                     value ->> 'breakTakenMs' AS breakTakenMs, value ->> 'breakSkipped' AS breakSkipped
              FROM json_each(${JSON.stringify(sectionRows)})) AS v
        WHERE "AttemptSection"."attemptId" = ${attemptId}
          AND "AttemptSection"."sectionOrder" = v.sectionOrder
          AND ${open}`),
    );
  }
  statements.push(
    db.run(sql`
      UPDATE "Attempt" SET
        "syncedSeq" = ${ackedSeq},
        "phase" = CASE WHEN ${applyState} THEN ${input.phase} ELSE "phase" END,
        "currentSectionOrder" = CASE WHEN ${applyState} THEN ${input.currentSectionOrder}
                                     ELSE "currentSectionOrder" END
      WHERE "id" = ${attemptId} AND "status" = 'IN_PROGRESS' AND "syncedSeq" <= ${ackedSeq}`),
  );
  await batch(db, statements);

  return { attemptId, ackedSeq, applied: applyState, serverTime: new Date() };
}
