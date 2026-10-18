import { and, desc, eq, isNotNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Db } from '../../db/client';
import {
  type AttemptStatus,
  attemptQuestions,
  attempts,
} from '../../db/schema';
import type { AuthUser } from '../../lib/access';
import { AppError } from '../../lib/app-error';
import { countAll, inList } from '../../lib/sql';
import { zIdList } from '../../lib/validation';
import { percentOf } from '../attempts/grading';
import { MAX_ANSWER_TIME_MS, settleClosedAttempts } from '../attempts/service';

/** Most exams one comparison can hold. */
export const MAX_COMPARE = 5;

/** Newest attempts read per request (across all exams of a comparison); keeps the CPU bounded. */
const MAX_ATTEMPTS = 500;

/** `?examIds=a,b,c`: Hono keeps one value per query key, so the list is comma-separated. */
export const compareQuery = z.strictObject({
  examIds: z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    )
    .pipe(zIdList('examIds', MAX_COMPARE).min(2)),
});

/** Where an average time per answer comes from: app measurements, the attempt duration, or both. */
export type TimeSource = 'measured' | 'estimated' | 'mixed';

export interface AttemptStatRow {
  id: string;
  examId: string;
  examTitle: string;
  status: AttemptStatus;
  startedAt: Date;
  expiresAt: Date | null;
  submittedAt: Date | null;
  correctCount: number | null;
  totalQuestions: number;
  answered: number;
  timedCount: number;
  timedMs: number;
}

export interface DomainStatRow {
  examId: string;
  domainId: string | null;
  name: string | null;
  total: number;
  correct: number;
  answered: number;
  timedCount: number;
  timedMs: number;
}

/** Only closed, graded attempts count. */
const gradedClosed = (userId: string, examIds?: readonly string[]) =>
  and(
    eq(attempts.userId, userId),
    ne(attempts.status, 'IN_PROGRESS'),
    isNotNull(attempts.score),
    examIds ? inList(attempts.examId, examIds) : undefined,
  );

/**
 * Answers the app timed (`dwellMs`: PATCH /answers adds `timeSpentMs`, sectioned attempts sync it).
 * Attempts made before timing existed have none.
 */
const timed = sql`${attemptQuestions.response} IS NOT NULL AND coalesce(${attemptQuestions.dwellMs}, 0) > 0`;
const answerTallies = {
  answered: sql<number>`count(*) FILTER (WHERE ${attemptQuestions.response} IS NOT NULL)`,
  timedCount: sql<number>`count(*) FILTER (WHERE ${timed})`,
  timedMs: sql<number>`coalesce(sum(${attemptQuestions.dwellMs}) FILTER (WHERE ${timed}), 0)`,
};
const domainId = sql<
  string | null
>`${attemptQuestions.snapshot} ->> '$.domain.id'`;

/** Exams the user has finished at least once, most recent first (the report picker). */
export async function listReportExams(db: Db, user: AuthUser) {
  await settleClosedAttempts(db, user.id);
  const rows = await db
    .select({
      examId: attempts.examId,
      // A bare column next to a single max(): SQLite takes it from the newest attempt.
      // Don't add another min()/max() to this query (ORDER BY included); sort in JS instead.
      examTitle: attempts.examTitle,
      lastAttemptAt: sql`max(${attempts.startedAt})`.mapWith(
        attempts.startedAt,
      ),
      attemptCount: countAll(),
      correct: sql<number>`sum(${attempts.correctCount})`,
      total: sql<number>`sum(${attempts.totalQuestions})`,
    })
    .from(attempts)
    .where(gradedClosed(user.id))
    .groupBy(attempts.examId);

  const items = rows
    .map(({ correct, total, ...row }) => ({
      ...row,
      avgCorrectPercent: percentOf(correct, total),
    }))
    .sort((a, b) => b.lastAttemptAt.getTime() - a.lastAttemptAt.getTime());
  return { items };
}

export async function examReport(db: Db, user: AuthUser, examId: string) {
  const [report] = await loadReports(db, user, [examId]);
  return report;
}

/** Several exams side by side, in the order requested. */
export async function compareReports(
  db: Db,
  user: AuthUser,
  examIds: string[],
) {
  return { exams: await loadReports(db, user, examIds) };
}

async function loadReports(db: Db, user: AuthUser, examIds: string[]) {
  await settleClosedAttempts(db, user.id, examIds);
  const where = gradedClosed(user.id, examIds);

  // Two statements, one round trip. JSON is read inside D1, so only small aggregate rows come back.
  const [attemptRows, domainRows] = await db.batch([
    db
      .select({
        id: attempts.id,
        examId: attempts.examId,
        examTitle: attempts.examTitle,
        status: attempts.status,
        startedAt: attempts.startedAt,
        expiresAt: attempts.expiresAt,
        submittedAt: attempts.submittedAt,
        correctCount: attempts.correctCount,
        totalQuestions: attempts.totalQuestions,
        ...answerTallies,
      })
      .from(attempts)
      .innerJoin(attemptQuestions, eq(attemptQuestions.attemptId, attempts.id))
      .where(where)
      .groupBy(attempts.id)
      .orderBy(desc(attempts.startedAt))
      .limit(MAX_ATTEMPTS),
    db
      .select({
        examId: attempts.examId,
        domainId,
        name: sql<
          string | null
        >`${attemptQuestions.snapshot} ->> '$.domain.name'`,
        total: countAll(),
        correct: sql<number>`count(*) FILTER (WHERE ${attemptQuestions.isCorrect})`,
        ...answerTallies,
      })
      .from(attemptQuestions)
      .innerJoin(attempts, eq(attempts.id, attemptQuestions.attemptId))
      .where(where)
      .groupBy(attempts.examId, domainId),
  ]);

  const attemptsByExam = groupByExam(attemptRows);
  const domainsByExam = groupByExam(domainRows);
  const missing = examIds.filter((id) => !attemptsByExam.has(id));
  if (missing.length > 0) {
    throw new AppError(
      404,
      'NOT_FOUND',
      examIds.length === 1
        ? 'No finished attempts for this exam yet'
        : `No finished attempts for ${missing.length} of the selected exams`,
      { examIds: missing },
    );
  }

  return examIds.map((examId) =>
    buildReport(
      examId,
      // Newest first from SQL; the report reads oldest → newest.
      attemptsByExam.get(examId)!.reverse(),
      domainsByExam.get(examId) ?? [],
    ),
  );
}

function groupByExam<T extends { examId: string }>(rows: T[]) {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const group = groups.get(row.examId);
    if (group) group.push(row);
    else groups.set(row.examId, [row]);
  }
  return groups;
}

/** Time actually spent: an expired attempt is often closed later than its deadline. */
function durationMs(row: AttemptStatRow) {
  if (!row.submittedAt) return 0;
  const end =
    row.expiresAt && row.expiresAt.getTime() < row.submittedAt.getTime()
      ? row.expiresAt
      : row.submittedAt;
  return Math.max(0, end.getTime() - row.startedAt.getTime());
}

/** Total time credited to an attempt's answers and how many answers it covers. */
function answerTime(row: AttemptStatRow) {
  if (row.timedCount > 0) {
    return { ms: row.timedMs, count: row.timedCount, estimated: false };
  }
  if (row.answered > 0) {
    // Recorded before timing existed: spread the attempt's duration over its answers.
    const perAnswer = Math.min(
      durationMs(row) / row.answered,
      MAX_ANSWER_TIME_MS,
    );
    return {
      ms: perAnswer * row.answered,
      count: row.answered,
      estimated: true,
    };
  }
  return { ms: 0, count: 0, estimated: false };
}

const average = (ms: number, count: number) =>
  count > 0 ? Math.round(ms / count) : null;

/**
 * One exam's report from its aggregate rows. `attemptRows` must be oldest → newest and non-empty.
 * "% correct" is correct answers / questions (not the points-weighted `percent` of results).
 */
export function buildReport(
  examId: string,
  attemptRows: AttemptStatRow[],
  domainRows: DomainStatRow[],
) {
  const reportAttempts = attemptRows.map((row) => {
    const time = answerTime(row);
    return {
      attemptId: row.id,
      startedAt: row.startedAt,
      status: row.status,
      correctPercent: percentOf(row.correctCount ?? 0, row.totalQuestions),
      correctCount: row.correctCount ?? 0,
      answeredCount: row.answered,
      totalQuestions: row.totalQuestions,
      durationSeconds: Math.round(durationMs(row) / 1000),
      avgTimePerAnswerMs: average(time.ms, time.count),
      timeEstimated: time.estimated,
      time,
    };
  });

  let total = 0;
  let correct = 0;
  let answered = 0;
  let timeMs = 0;
  let timeCount = 0;
  const sources = new Set<boolean>();
  for (const row of reportAttempts) {
    total += row.totalQuestions;
    correct += row.correctCount;
    answered += row.answeredCount;
    if (row.time.count > 0) {
      timeMs += row.time.ms;
      timeCount += row.time.count;
      sources.add(row.time.estimated);
    }
  }
  const timeSource: TimeSource | null =
    sources.size === 0
      ? null
      : sources.size === 2
        ? 'mixed'
        : sources.has(true)
          ? 'estimated'
          : 'measured';

  const percents = reportAttempts.map((row) => row.correctPercent);
  const domains = domainRows
    .map((row) => ({
      domainId: row.domainId,
      name: row.domainId === null ? null : row.name,
      total: row.total,
      correct: row.correct,
      wrong: row.answered - row.correct,
      unanswered: row.total - row.answered,
      correctPercent: percentOf(row.correct, row.total),
      avgTimePerAnswerMs: average(row.timedMs, row.timedCount),
    }))
    .sort((a, b) =>
      a.domainId === null
        ? 1
        : b.domainId === null
          ? -1
          : (a.name ?? '').localeCompare(b.name ?? ''),
    );

  return {
    examId,
    examTitle: attemptRows[attemptRows.length - 1]!.examTitle,
    summary: {
      attemptCount: reportAttempts.length,
      avgCorrectPercent: percentOf(correct, total),
      latestCorrectPercent: percents[percents.length - 1] ?? 0,
      bestCorrectPercent: Math.max(...percents),
      avgTimePerAnswerMs: average(timeMs, timeCount),
      timeSource,
      outcomes: {
        total,
        correct,
        wrong: answered - correct,
        unanswered: total - answered,
      },
    },
    attempts: reportAttempts.map(({ time: _time, ...row }) => row),
    domains,
  };
}
