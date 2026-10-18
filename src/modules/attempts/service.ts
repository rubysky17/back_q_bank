import { and, asc, desc, eq, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import { batch, type Db } from '../../db/client';
import { isUniqueViolation } from '../../db/errors';
import {
  ATTEMPT_STATUSES,
  attemptEvents,
  attemptQuestions,
  attempts,
  attemptSections,
  type AttemptSectionStatus,
  type Difficulty,
  exams,
  type QuestionMedia,
  type QuestionType,
} from '../../db/schema';
import type { AuthUser } from '../../lib/access';
import { AppError } from '../../lib/app-error';
import { offsetOf, paginated } from '../../lib/pagination';
import { shuffle } from '../../lib/random';
import { countAll, inList, qualified } from '../../lib/sql';
import { uuidv7 } from '../../lib/uuidv7';
import { paginationFields, zId } from '../../lib/validation';
import { loadSections } from '../exams/service';
import {
  getQuestionTypeHandler,
  type QuestionSnapshot,
} from '../questions/question-types';
import { type GradedItem, percentOf, summarize } from './grading';

/** Answers are still accepted this long after `expiresAt` to absorb network latency. */
export const ANSWER_GRACE_MS = 30_000;

/** Longest stretch credited to one answer pick; anything longer is idle time. */
export const MAX_ANSWER_TIME_MS = 10 * 60_000;

/** Columns of the partial unique index "one in-progress attempt per user and exam". */
const IN_PROGRESS_INDEX_COLUMNS = 'Attempt.userId, Attempt.examId';

export const listAttemptsQuery = z.strictObject({
  ...paginationFields,
  examId: zId().optional(),
  status: z.enum(ATTEMPT_STATUSES).optional(),
});

/** Saves several answers at once (the app can batch while offline or between questions). */
export const saveAnswersSchema = z.strictObject({
  answers: z
    .array(
      z.strictObject({
        attemptQuestionId: zId(),
        /** Type-specific answer. SINGLE_CHOICE: { "optionId": "..." }. null clears the answer; omit to keep it. */
        response: z.record(z.string(), z.unknown()).nullable().optional(),
        /** "Mark for review". Omit to keep the current flag. */
        flagged: z.boolean().optional(),
        /** Foreground time spent on the question since the last save; added to its total. */
        timeSpentMs: z.number().int().min(0).optional(),
      }),
    )
    .min(1)
    .max(500),
});

/** `fresh: true` abandons the attempt in progress (kept in history and reports) and starts a new one. */
export const startAttemptSchema = z.strictObject({
  fresh: z.boolean().optional(),
});


type ListAttemptsQuery = z.infer<typeof listAttemptsQuery>;
type SaveAnswersInput = z.infer<typeof saveAnswersSchema>;

const attemptColumns = {
  id: attempts.id,
  examId: attempts.examId,
  userId: attempts.userId,
  examTitle: attempts.examTitle,
  status: attempts.status,
  mode: attempts.mode,
  phase: attempts.phase,
  currentSectionOrder: attempts.currentSectionOrder,
  syncedSeq: attempts.syncedSeq,
  passingScore: attempts.passingScore,
  breakMinutes: attempts.breakMinutes,
  startedAt: attempts.startedAt,
  expiresAt: attempts.expiresAt,
  submittedAt: attempts.submittedAt,
  abandonedAt: attempts.abandonedAt,
  score: attempts.score,
  maxScore: attempts.maxScore,
  correctCount: attempts.correctCount,
  totalQuestions: attempts.totalQuestions,
  passed: attempts.passed,
};

function selectAttempts(db: Db) {
  return db.select(attemptColumns).from(attempts);
}

export type AttemptRow = Awaited<ReturnType<typeof selectAttempts>>[number];

function isOverdue(
  attempt: Pick<AttemptRow, 'status' | 'expiresAt'>,
  now = new Date(),
) {
  return (
    attempt.status === 'IN_PROGRESS' &&
    attempt.expiresAt !== null &&
    now.getTime() > attempt.expiresAt.getTime() + ANSWER_GRACE_MS
  );
}

export const closedError = () =>
  AppError.conflict(
    'ATTEMPT_CLOSED',
    'This attempt has already been submitted',
  );

const asSnapshot = (value: unknown) => value as QuestionSnapshot;

export const parseJson = (value: unknown) =>
  typeof value === 'string' ? (JSON.parse(value) as unknown) : value;

/**
 * Parts of the snapshot read straight from its JSON text. D1 rows are decoded in JavaScript, so
 * reading only the fields a request needs (instead of whole snapshots) is the main CPU saving.
 */
export const snapshotField = {
  type: sql<QuestionType>`${attemptQuestions.snapshot} ->> '$.type'`,
  content: sql<string>`${attemptQuestions.snapshot} ->> '$.content'`,
  difficulty: sql<Difficulty>`${attemptQuestions.snapshot} ->> '$.difficulty'`,
  data: () =>
    sql<unknown>`${attemptQuestions.snapshot} ->> '$.data'`.mapWith(parseJson),
  answerKey: () =>
    sql<unknown>`${attemptQuestions.snapshot} ->> '$.answerKey'`.mapWith(
      parseJson,
    ),
  domain: () =>
    sql`${attemptQuestions.snapshot} ->> '$.domain'`.mapWith(
      (value) => parseJson(value) as QuestionSnapshot['domain'],
    ),
  caseStudy: () =>
    sql`${attemptQuestions.snapshot} ->> '$.caseStudy'`.mapWith(
      (value) => (parseJson(value) ?? null) as ViewQuestion['caseStudy'],
    ),
  /** Only the images shown with the stem; explanation images wait for the review. */
  contentMedia: () =>
    sql`${attemptQuestions.snapshot} ->> '$.media'`.mapWith((value) =>
      contentMediaOf(parseJson(value) as QuestionMedia[] | null),
    ),
  sourceNumber: sql<
    number | null
  >`${attemptQuestions.snapshot} ->> '$.sourceNumber'`,
};

const contentMediaOf = (media: QuestionMedia[] | null | undefined) =>
  (media ?? []).filter((item) => item.placement === 'CONTENT');

/**
 * Starts an attempt on a published exam, or resumes the one in progress (double taps and app restarts
 * land on the same attempt). Questions are frozen into snapshots so later edits by the host don't matter.
 *
 * With `fresh`, the attempt in progress is closed as ABANDONED first (graded on its next read, which
 * keeps this request within the CPU budget) and a new one starts.
 *
 * When every section has its own `durationMinutes`, the attempt is SECTIONED: no server deadline; the
 * app runs each section clock (paused while the user is away) and uploads its state with `sync`.
 */
export async function startAttempt(
  db: Db,
  user: AuthUser,
  examId: string,
  options: z.infer<typeof startAttemptSchema> = {},
) {
  const [exam] = await db
    .select({
      id: exams.id,
      title: exams.title,
      durationMinutes: exams.durationMinutes,
      breakMinutes: exams.breakMinutes,
      passingScore: exams.passingScore,
      shuffleQuestions: exams.shuffleQuestions,
      shuffleOptions: exams.shuffleOptions,
    })
    .from(exams)
    .where(and(eq(exams.id, examId), eq(exams.status, 'PUBLISHED')));
  if (!exam) throw AppError.notFound('Exam');

  const resumable = await findInProgress(db, user.id, examId);
  if (resumable) {
    if (!options.fresh) {
      return { resumed: true, ...(await view(db, resumable.id)) };
    }
    await close(db, resumable.id, 'ABANDONED');
  }

  const plannedSections = await loadSections(db, examId);
  const sectioned =
    plannedSections.length > 0 &&
    plannedSections.every((section) => section.durationMinutes !== null);
  let order = 0;
  const rows = plannedSections.flatMap((section) => {
    const items = exam.shuffleQuestions
      ? shuffle(section.questions)
      : section.questions;
    return items.map(({ points, sourceNumber, question }) => {
      const handler = getQuestionTypeHandler(question.type);
      const { data, answerKey } = handler.buildSnapshot(
        handler.parseDefinition(question.definition),
        { shuffleOptions: exam.shuffleOptions },
      );
      const snapshot: QuestionSnapshot = {
        type: question.type,
        content: question.content,
        explanation: question.explanation,
        difficulty: question.difficulty,
        domain: question.domain,
        caseStudy: question.caseStudy,
        media: question.media,
        sourceNumber,
        data,
        answerKey,
      };
      return {
        id: uuidv7(),
        questionId: question.id,
        questionVersion: question.version,
        sectionId: section.id,
        sectionTitle: section.title,
        sectionOrder: section.order,
        order: ++order,
        points,
        snapshot,
      };
    });
  });
  if (rows.length === 0) {
    throw AppError.conflict('EXAM_EMPTY', 'This exam has no questions');
  }

  const now = new Date();
  const attempt: Omit<AttemptRow, 'userId'> = {
    id: uuidv7(),
    examId,
    examTitle: exam.title,
    status: 'IN_PROGRESS',
    mode: sectioned ? 'SECTIONED' : 'LEGACY',
    phase: sectioned ? 'NOT_STARTED' : null,
    currentSectionOrder: sectioned ? plannedSections[0].order : null,
    syncedSeq: 0,
    passingScore: exam.passingScore,
    breakMinutes: sectioned ? exam.breakMinutes : null,
    startedAt: now,
    expiresAt:
      !sectioned && exam.durationMinutes
        ? new Date(now.getTime() + exam.durationMinutes * 60_000)
        : null,
    submittedAt: null,
    abandonedAt: null,
    score: null,
    maxScore: rows.reduce((sum, row) => sum + row.points, 0),
    correctCount: null,
    totalQuestions: rows.length,
    passed: null,
  };
  const attemptId = attempt.id;
  const sectionRows: AttemptSectionView[] = sectioned
    ? plannedSections
        .filter((section) => section.questions.length > 0)
        .map((section) => ({
          id: uuidv7(),
          sectionId: section.id,
          sectionOrder: section.order,
          budgetMs: section.durationMinutes! * 60_000,
          usedMs: 0,
          status: 'LOCKED' as AttemptSectionStatus,
          startedAt: null,
          endedAt: null,
          endReason: null,
          breakTakenMs: null,
          breakSkipped: null,
        }))
    : [];
  try {
    // One batch: the attempt never exists without its questions. The questions go in through one
    // JSON parameter (D1 allows 100 bound parameters per statement).
    await batch(db, [
      db.insert(attempts).values({ ...attempt, userId: user.id }),
      ...(sectionRows.length > 0
        ? [
            db.insert(attemptSections).values(
              sectionRows.map(({ id, sectionId, sectionOrder, budgetMs }) => ({
                id,
                attemptId,
                sectionId,
                sectionOrder,
                budgetMs,
              })),
            ),
          ]
        : []),
      db.run(sql`
        INSERT INTO "AttemptQuestion" ("id", "attemptId", "questionId", "questionVersion", "sectionId",
          "sectionTitle", "sectionOrder", "order", "points", "snapshot", "flagged")
        SELECT value ->> 'id', ${attemptId}, value ->> 'questionId', value ->> 'questionVersion',
          value ->> 'sectionId', value ->> 'sectionTitle', value ->> 'sectionOrder', value ->> 'order',
          value ->> 'points', value -> 'snapshot', 0
        FROM json_each(${JSON.stringify(rows)})`),
    ]);
  } catch (error) {
    // Another request started the same attempt a moment ago (partial unique index).
    if (isUniqueViolation(error, IN_PROGRESS_INDEX_COLUMNS)) {
      const current = await findInProgress(db, user.id, examId);
      if (current) return { resumed: true, ...(await view(db, current.id)) };
    }
    throw error;
  }
  // Everything the test screen needs was just written: answer from memory instead of reading it back.
  return {
    resumed: false,
    ...shapeView(
      attempt,
      rows.map(
        ({
          id,
          order,
          sectionId,
          sectionTitle,
          sectionOrder,
          points,
          snapshot,
        }) => ({
          id,
          order,
          sectionId,
          sectionTitle,
          sectionOrder,
          points,
          response: null,
          flagged: false,
          answeredAt: null,
          ...EMPTY_TRACE,
          type: snapshot.type,
          content: snapshot.content,
          caseStudy: snapshot.caseStudy ?? null,
          media: contentMediaOf(snapshot.media),
          sourceNumber: snapshot.sourceNumber ?? null,
          data: snapshot.data,
        }),
      ),
      sectionRows,
    ),
  };
}

export async function listAttempts(
  db: Db,
  user: AuthUser,
  query: ListAttemptsQuery,
) {
  await expireOverdueForUser(db, user.id);
  const where = and(
    eq(attempts.userId, user.id),
    query.examId ? eq(attempts.examId, query.examId) : undefined,
    query.status ? eq(attempts.status, query.status) : undefined,
  );
  const rows = await db
    .select({
      ...attemptColumns,
      answeredCount: sql<number>`(SELECT count(*) FROM ${attemptQuestions} WHERE ${qualified(attemptQuestions.attemptId)} = ${qualified(attempts.id)} AND ${qualified(attemptQuestions.response)} IS NOT NULL)`,
    })
    .from(attempts)
    .where(where)
    .orderBy(desc(attempts.startedAt), desc(attempts.id))
    .limit(query.limit)
    .offset(offsetOf(query));
  const [{ total }] = await db
    .select({ total: countAll() })
    .from(attempts)
    .where(where);
  const items = rows.map(({ userId: _userId, ...attempt }) => ({
    ...attempt,
    percent:
      attempt.score === null
        ? null
        : percentOf(attempt.score, attempt.maxScore),
  }));
  return paginated(items, total, query);
}

/** Current state for the test screen: questions without answers, saved responses and the timer. */
export async function getAttempt(db: Db, user: AuthUser, attemptId: string) {
  const attempt = await findOwned(db, user, attemptId);
  if (isOverdue(attempt)) await finalize(db, attempt.id, 'EXPIRED');
  return view(db, attempt.id);
}

export async function saveAnswers(
  db: Db,
  user: AuthUser,
  attemptId: string,
  input: SaveAnswersInput,
) {
  const attempt = await findOwned(db, user, attemptId);
  if (attempt.status !== 'IN_PROGRESS') throw closedError();
  if (attempt.mode === 'SECTIONED') {
    throw AppError.conflict(
      'ATTEMPT_SECTIONED',
      'This attempt is saved with POST /attempts/:id/sync',
    );
  }
  if (isOverdue(attempt)) {
    await finalize(db, attempt.id, 'EXPIRED');
    throw AppError.conflict(
      'ATTEMPT_EXPIRED',
      'Time is up; the attempt was submitted automatically',
    );
  }

  const ids = input.answers.map((answer) => answer.attemptQuestionId);
  if (new Set(ids).size !== ids.length) {
    throw AppError.badRequest(
      'DUPLICATE_ANSWER',
      'Each question can appear only once per request',
    );
  }

  const questions = await db
    .select({
      id: attemptQuestions.id,
      type: snapshotField.type,
      data: snapshotField.data(),
    })
    .from(attemptQuestions)
    .where(
      and(
        eq(attemptQuestions.attemptId, attemptId),
        inList(attemptQuestions.id, ids),
      ),
    );
  const snapshots = new Map(
    questions.map((question) => [question.id, question]),
  );
  const unknown = ids.filter((id) => !snapshots.has(id));
  if (unknown.length > 0) {
    throw AppError.badRequest(
      'INVALID_ATTEMPT_QUESTION',
      `${unknown.length} question(s) do not belong to this attempt`,
      { attemptQuestionIds: unknown },
    );
  }

  const now = Date.now();
  const changes = input.answers.flatMap((answer) => {
    const setResponse = answer.response !== undefined;
    const setFlag = answer.flagged !== undefined;
    const addTime = Math.min(answer.timeSpentMs ?? 0, MAX_ANSWER_TIME_MS);
    if (!setResponse && !setFlag && addTime === 0) return [];
    let response: unknown = null;
    if (answer.response) {
      const snapshot = snapshots.get(answer.attemptQuestionId)!;
      response = getQuestionTypeHandler(snapshot.type).parseResponse(
        snapshot.data,
        answer.response,
      );
    }
    return [
      {
        id: answer.attemptQuestionId,
        setResponse,
        // Stored as JSON text; null clears the answer.
        response: response === null ? null : JSON.stringify(response),
        answeredAt: response === null ? null : now,
        setFlag,
        flagged: answer.flagged ?? false,
        addTime,
      },
    ];
  });

  if (changes.length > 0) {
    // One statement for the whole batch. The EXISTS guard makes it atomic with submit/expiry:
    // once the attempt is closed, no answer can land after grading.
    const updated = await db.run(sql`
      UPDATE "AttemptQuestion" SET
        "response" = CASE WHEN v.setResponse THEN v.response ELSE "AttemptQuestion"."response" END,
        "answeredAt" = CASE WHEN v.setResponse THEN v.answeredAt ELSE "AttemptQuestion"."answeredAt" END,
        "flagged" = CASE WHEN v.setFlag THEN v.flagged ELSE "AttemptQuestion"."flagged" END,
        "dwellMs" = CASE WHEN v.addTime > 0 THEN coalesce("AttemptQuestion"."dwellMs", 0) + v.addTime
                         ELSE "AttemptQuestion"."dwellMs" END
      FROM (SELECT value ->> 'id' AS id, value ->> 'setResponse' AS setResponse,
                   value ->> 'response' AS response, value ->> 'answeredAt' AS answeredAt,
                   value ->> 'setFlag' AS setFlag, value ->> 'flagged' AS flagged,
                   value ->> 'addTime' AS addTime
            FROM json_each(${JSON.stringify(changes)})) AS v
      WHERE "AttemptQuestion"."id" = v.id AND "AttemptQuestion"."attemptId" = ${attemptId}
        AND EXISTS (SELECT 1 FROM "Attempt" WHERE "Attempt"."id" = ${attemptId}
                    AND "Attempt"."status" = 'IN_PROGRESS')`);
    if (updated.meta.changes !== changes.length) throw closedError();
  }

  const [{ answeredCount, flaggedCount }] = await db
    .select({
      answeredCount: sql<number>`count(*) FILTER (WHERE ${attemptQuestions.response} IS NOT NULL)`,
      flaggedCount: sql<number>`count(*) FILTER (WHERE ${attemptQuestions.flagged})`,
    })
    .from(attemptQuestions)
    .where(eq(attemptQuestions.attemptId, attemptId));
  return {
    attemptId,
    saved: ids.length,
    answeredCount,
    flaggedCount,
    serverTime: new Date(),
  };
}

/**
 * Idempotent: submitting again (e.g. a retry after a lost response) returns the same result.
 * A SECTIONED attempt must first upload its ATTEMPT_SUBMIT event, so no answer made offline is lost.
 */
export async function submitAttempt(db: Db, user: AuthUser, attemptId: string) {
  const attempt = await findOwned(db, user, attemptId);
  if (attempt.status === 'IN_PROGRESS' && attempt.mode === 'SECTIONED') {
    const [submitted] = await db
      .select({ id: attemptEvents.id })
      .from(attemptEvents)
      .where(
        and(
          eq(attemptEvents.attemptId, attemptId),
          eq(attemptEvents.type, 'ATTEMPT_SUBMIT'),
        ),
      )
      .limit(1);
    if (!submitted) {
      throw AppError.conflict(
        'ATTEMPT_NOT_SYNCED',
        'Upload the attempt with sync before submitting it',
      );
    }
  }
  if (attempt.status === 'IN_PROGRESS') {
    await finalize(
      db,
      attempt.id,
      isOverdue(attempt) ? 'EXPIRED' : 'SUBMITTED',
    );
  }
  return attemptResult(db, user, attemptId);
}

/**
 * The user gave up on the attempt (or started the exam over). What was answered is graded and stays
 * in history and reports; it never counts as a pass or fail. Idempotent.
 */
export async function abandonAttempt(
  db: Db,
  user: AuthUser,
  attemptId: string,
) {
  const attempt = await findOwned(db, user, attemptId);
  if (attempt.status === 'IN_PROGRESS') {
    await finalize(db, attempt.id, 'ABANDONED');
  }
  const closed = await findOwned(db, user, attemptId);
  return {
    attemptId,
    status: closed.status,
    abandonedAt: closed.abandonedAt,
  };
}

export async function attemptResult(db: Db, user: AuthUser, attemptId: string) {
  const attempt = await findClosed(db, user, attemptId);
  const questions = await db
    .select({
      sectionId: attemptQuestions.sectionId,
      sectionTitle: attemptQuestions.sectionTitle,
      sectionOrder: attemptQuestions.sectionOrder,
      points: attemptQuestions.points,
      score: attemptQuestions.score,
      isCorrect: attemptQuestions.isCorrect,
      answered: sql<number>`${attemptQuestions.response} IS NOT NULL`,
      domain: snapshotField.domain(),
      difficulty: snapshotField.difficulty,
    })
    .from(attemptQuestions)
    .where(eq(attemptQuestions.attemptId, attemptId));
  const items: GradedItem[] = questions.map((question) => {
    return {
      sectionId: question.sectionId,
      sectionTitle: question.sectionTitle,
      sectionOrder: question.sectionOrder,
      domain: question.domain,
      difficulty: question.difficulty,
      points: question.points,
      score: question.score ?? 0,
      isCorrect: question.isCorrect === true,
      answered: Boolean(question.answered),
    };
  });
  const { overall, sections, domains, difficulties } = summarize(items);
  const timing =
    attempt.mode === 'SECTIONED'
      ? await loadAttemptSections(db, attemptId)
      : [];

  return {
    attemptId: attempt.id,
    examId: attempt.examId,
    examTitle: attempt.examTitle,
    status: attempt.status,
    startedAt: attempt.startedAt,
    submittedAt: attempt.submittedAt,
    mode: attempt.mode,
    abandonedAt: attempt.abandonedAt,
    timeSpentSeconds:
      attempt.mode === 'SECTIONED'
        ? Math.round(timing.reduce((sum, s) => sum + s.usedMs, 0) / 1000)
        : attempt.submittedAt
          ? Math.round(
              (attempt.submittedAt.getTime() - attempt.startedAt.getTime()) /
                1000,
            )
          : null,
    sectionTiming: timing,
    score: overall.score,
    maxScore: overall.maxScore,
    percent: overall.percent,
    correctCount: overall.correct,
    answeredCount: overall.answered,
    totalQuestions: overall.total,
    passingScore: attempt.passingScore,
    passed: attempt.passed,
    breakdown: { sections, domains, difficulties },
  };
}

/** Correct answers and explanations — only once the attempt is closed. */
export async function attemptReview(db: Db, user: AuthUser, attemptId: string) {
  const attempt = await findClosed(db, user, attemptId);
  const questions = await db
    .select({
      id: attemptQuestions.id,
      order: attemptQuestions.order,
      sectionId: attemptQuestions.sectionId,
      sectionTitle: attemptQuestions.sectionTitle,
      sectionOrder: attemptQuestions.sectionOrder,
      points: attemptQuestions.points,
      score: attemptQuestions.score,
      isCorrect: attemptQuestions.isCorrect,
      response: attemptQuestions.response,
      flagged: attemptQuestions.flagged,
      ...traceColumns,
      snapshot: attemptQuestions.snapshot,
    })
    .from(attemptQuestions)
    .where(eq(attemptQuestions.attemptId, attemptId))
    .orderBy(asc(attemptQuestions.order));
  return {
    attemptId: attempt.id,
    examId: attempt.examId,
    examTitle: attempt.examTitle,
    status: attempt.status,
    mode: attempt.mode,
    questions: questions.map(({ snapshot, ...question }) => {
      const {
        type,
        content,
        difficulty,
        domain,
        caseStudy,
        media,
        sourceNumber,
        data,
        answerKey,
        explanation,
      } = asSnapshot(snapshot);
      return {
        ...question,
        type,
        content,
        difficulty,
        domain,
        caseStudy: caseStudy ?? null,
        media: media ?? [],
        sourceNumber: sourceNumber ?? null,
        data,
        answerKey,
        explanation,
      };
    }),
  };
}

/** Closes attempts whose time ran out while the user was away (called before listing). */
async function expireOverdueForUser(db: Db, userId: string) {
  const overdue = await db
    .select({ id: attempts.id })
    .from(attempts)
    .where(
      and(
        eq(attempts.userId, userId),
        eq(attempts.status, 'IN_PROGRESS'),
        lt(attempts.expiresAt, new Date(Date.now() - ANSWER_GRACE_MS)),
      ),
    );
  for (const { id } of overdue) {
    await finalize(db, id, 'EXPIRED');
  }
}

/** The user's in-progress attempt on an exam, if its time has not run out. */
export async function findInProgress(db: Db, userId: string, examId: string) {
  const [attempt] = await selectAttempts(db)
    .where(
      and(
        eq(attempts.userId, userId),
        eq(attempts.examId, examId),
        eq(attempts.status, 'IN_PROGRESS'),
      ),
    )
    .limit(1);
  if (!attempt) return null;
  if (isOverdue(attempt)) {
    await finalize(db, attempt.id, 'EXPIRED');
    return null;
  }
  return attempt;
}

/**
 * Closes overdue attempts and grades closed ones that missed grading, so statistics see final scores.
 * Capped per request because grading is the CPU-heavy part; callers still filter `score IS NOT NULL`,
 * and anything skipped is settled by a later request.
 */
export async function settleClosedAttempts(
  db: Db,
  userId: string,
  examIds?: readonly string[],
  limit = 2,
) {
  const pending = await db
    .select({ id: attempts.id, status: attempts.status })
    .from(attempts)
    .where(
      and(
        eq(attempts.userId, userId),
        examIds ? inList(attempts.examId, examIds) : undefined,
        or(
          and(
            eq(attempts.status, 'IN_PROGRESS'),
            lt(attempts.expiresAt, new Date(Date.now() - ANSWER_GRACE_MS)),
          ),
          and(ne(attempts.status, 'IN_PROGRESS'), isNull(attempts.score)),
        ),
      ),
    )
    .limit(limit);
  for (const { id, status } of pending) {
    if (status === 'IN_PROGRESS') await finalize(db, id, 'EXPIRED');
    else await grade(db, id);
  }
}

/**
 * Closes an attempt, then grades it. Closing is a conditional update, so concurrent calls (double
 * submit, submit racing with expiry) agree on a single winner; from that moment saveAnswers can no
 * longer change any response, which makes grading deterministic and safe to repeat.
 */
async function finalize(db: Db, attemptId: string, status: ClosedStatus) {
  if (await close(db, attemptId, status)) await grade(db, attemptId);
}

type ClosedStatus = 'SUBMITTED' | 'EXPIRED' | 'ABANDONED';

/** The conditional IN_PROGRESS → closed update alone; true for the one caller that won. */
async function close(db: Db, attemptId: string, status: ClosedStatus) {
  const now = new Date();
  const closed = await db
    .update(attempts)
    .set(
      status === 'ABANDONED'
        ? { status, abandonedAt: now, phase: null }
        : { status, submittedAt: now },
    )
    .where(and(eq(attempts.id, attemptId), eq(attempts.status, 'IN_PROGRESS')))
    .returning({ id: attempts.id });
  return closed.length === 1;
}

/**
 * Writes scores for a closed attempt that has none yet. Normally runs right after finalize; if that
 * request died in between, the next read of the attempt (result, review, submit retry) grades it.
 */
async function grade(db: Db, attemptId: string) {
  const [attempt] = await db
    .select({
      status: attempts.status,
      maxScore: attempts.maxScore,
      passingScore: attempts.passingScore,
    })
    .from(attempts)
    .where(eq(attempts.id, attemptId));
  if (!attempt) return;

  const questions = await db
    .select({
      id: attemptQuestions.id,
      points: attemptQuestions.points,
      response: attemptQuestions.response,
      type: snapshotField.type,
      answerKey: snapshotField.answerKey(),
    })
    .from(attemptQuestions)
    .where(eq(attemptQuestions.attemptId, attemptId));
  const graded = questions.map((question) => {
    if (question.response === null) {
      return { id: question.id, isCorrect: false, score: 0 };
    }
    return {
      id: question.id,
      ...getQuestionTypeHandler(question.type).grade(
        question.answerKey,
        question.response,
        question.points,
      ),
    };
  });

  // One UPDATE per distinct (isCorrect, score) instead of one per question.
  const groups = new Map<
    string,
    { isCorrect: boolean; score: number; ids: string[] }
  >();
  for (const { id, isCorrect, score } of graded) {
    const key = `${isCorrect}:${score}`;
    const group = groups.get(key) ?? { isCorrect, score, ids: [] };
    group.ids.push(id);
    groups.set(key, group);
  }

  const score = graded.reduce((sum, item) => sum + item.score, 0);
  const percent = percentOf(score, attempt.maxScore);
  const finish = db
    .update(attempts)
    .set({
      score,
      correctCount: graded.filter((item) => item.isCorrect).length,
      // An abandoned attempt is unfinished: it never passes or fails.
      passed:
        attempt.passingScore === null || attempt.status === 'ABANDONED'
          ? null
          : percent >= attempt.passingScore,
    })
    .where(and(eq(attempts.id, attemptId), isNull(attempts.score)));
  await db.batch([
    finish,
    ...[...groups.values()].map(({ isCorrect, score: points, ids }) =>
      db
        .update(attemptQuestions)
        .set({ isCorrect, score: points })
        .where(inList(attemptQuestions.id, ids)),
    ),
  ]);
}

async function view(db: Db, attemptId: string) {
  const [attempt] = await selectAttempts(db).where(eq(attempts.id, attemptId));
  if (!attempt) throw AppError.notFound('Attempt');
  const sections =
    attempt.mode === 'SECTIONED'
      ? await loadAttemptSections(db, attemptId)
      : [];
  const questions = await db
    .select({
      id: attemptQuestions.id,
      order: attemptQuestions.order,
      sectionId: attemptQuestions.sectionId,
      sectionTitle: attemptQuestions.sectionTitle,
      sectionOrder: attemptQuestions.sectionOrder,
      points: attemptQuestions.points,
      response: attemptQuestions.response,
      flagged: attemptQuestions.flagged,
      answeredAt: attemptQuestions.answeredAt,
      ...traceColumns,
      type: snapshotField.type,
      content: snapshotField.content,
      caseStudy: snapshotField.caseStudy(),
      media: snapshotField.contentMedia(),
      sourceNumber: snapshotField.sourceNumber,
      data: snapshotField.data(),
    })
    .from(attemptQuestions)
    .where(eq(attemptQuestions.attemptId, attemptId))
    .orderBy(asc(attemptQuestions.order));

  return shapeView(attempt, questions, sections);
}

/** Decision trace of a question (SECTIONED attempts); all null until the app syncs it. */
const traceColumns = {
  confidence: attemptQuestions.confidence,
  eliminatedOptionIds: attemptQuestions.eliminatedOptionIds,
  firstResponse: attemptQuestions.firstResponse,
  dwellMs: attemptQuestions.dwellMs,
  timeToFirstAnswerMs: attemptQuestions.timeToFirstAnswerMs,
  timeToFinalAnswerMs: attemptQuestions.timeToFinalAnswerMs,
  visitCount: attemptQuestions.visitCount,
  answerChangeCount: attemptQuestions.answerChangeCount,
  eliminationCount: attemptQuestions.eliminationCount,
  everFlagged: attemptQuestions.everFlagged,
};

type Trace = {
  [K in keyof typeof traceColumns]:
    (typeof traceColumns)[K]['_']['data'] | null;
};

const EMPTY_TRACE: Trace = {
  confidence: null,
  eliminatedOptionIds: null,
  firstResponse: null,
  dwellMs: null,
  timeToFirstAnswerMs: null,
  timeToFinalAnswerMs: null,
  visitCount: null,
  answerChangeCount: null,
  eliminationCount: null,
  everFlagged: null,
};

export async function loadAttemptSections(db: Db, attemptId: string) {
  return db
    .select({
      id: attemptSections.id,
      sectionId: attemptSections.sectionId,
      sectionOrder: attemptSections.sectionOrder,
      budgetMs: attemptSections.budgetMs,
      usedMs: attemptSections.usedMs,
      status: attemptSections.status,
      startedAt: attemptSections.startedAt,
      endedAt: attemptSections.endedAt,
      endReason: attemptSections.endReason,
      breakTakenMs: attemptSections.breakTakenMs,
      breakSkipped: attemptSections.breakSkipped,
    })
    .from(attemptSections)
    .where(eq(attemptSections.attemptId, attemptId))
    .orderBy(asc(attemptSections.sectionOrder));
}

type AttemptSectionView = Awaited<
  ReturnType<typeof loadAttemptSections>
>[number];

interface ViewQuestion extends Trace {
  id: string;
  order: number;
  sectionId: string | null;
  sectionTitle: string;
  sectionOrder: number;
  points: number;
  response: unknown;
  flagged: boolean;
  answeredAt: Date | null;
  type: QuestionType;
  content: string;
  caseStudy: { title: string; content: string } | null;
  media: QuestionMedia[];
  sourceNumber: number | null;
  data: unknown;
}

/** The test-screen payload. Domain, difficulty, answer key and explanation stay hidden until review. */
function shapeView(
  {
    userId: _userId,
    ...attempt
  }: Omit<AttemptRow, 'userId'> & { userId?: string },
  questions: ViewQuestion[],
  timing: AttemptSectionView[] = [],
) {
  const clocks = new Map(timing.map((row) => [row.sectionOrder, row]));
  const sections = new Map<
    number,
    {
      sectionId: string | null;
      title: string;
      order: number;
      questionCount: number;
      /** SECTIONED only; null otherwise. */
      clock: Omit<
        AttemptSectionView,
        'id' | 'sectionId' | 'sectionOrder'
      > | null;
    }
  >();
  for (const question of questions) {
    const clock = clocks.get(question.sectionOrder);
    const section = sections.get(question.sectionOrder) ?? {
      sectionId: question.sectionId,
      title: question.sectionTitle,
      order: question.sectionOrder,
      questionCount: 0,
      clock: clock
        ? {
            budgetMs: clock.budgetMs,
            usedMs: clock.usedMs,
            status: clock.status,
            startedAt: clock.startedAt,
            endedAt: clock.endedAt,
            endReason: clock.endReason,
            breakTakenMs: clock.breakTakenMs,
            breakSkipped: clock.breakSkipped,
          }
        : null,
    };
    section.questionCount++;
    sections.set(question.sectionOrder, section);
  }

  return {
    ...attempt,
    serverTime: new Date(),
    answeredCount: questions.filter((question) => question.response !== null)
      .length,
    flaggedCount: questions.filter((question) => question.flagged).length,
    sections: [...sections.values()].sort((a, b) => a.order - b.order),
    questions,
  };
}

export async function findOwned(
  db: Db,
  user: AuthUser,
  attemptId: string,
): Promise<AttemptRow> {
  const [attempt] = await selectAttempts(db).where(eq(attempts.id, attemptId));
  if (!attempt || attempt.userId !== user.id) {
    throw AppError.notFound('Attempt');
  }
  return attempt;
}

/** Result and review need a closed, graded attempt; an overdue one is closed on the spot. */
async function findClosed(
  db: Db,
  user: AuthUser,
  attemptId: string,
): Promise<AttemptRow> {
  const attempt = await findOwned(db, user, attemptId);
  if (attempt.status === 'IN_PROGRESS') {
    if (!isOverdue(attempt)) {
      throw AppError.conflict(
        'ATTEMPT_NOT_SUBMITTED',
        'Submit the attempt to see the result',
      );
    }
    await finalize(db, attempt.id, 'EXPIRED');
    return findOwned(db, user, attemptId);
  }
  if (attempt.score === null) {
    await grade(db, attempt.id);
    return findOwned(db, user, attemptId);
  }
  return attempt;
}
