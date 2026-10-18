import { and, asc, count, desc, eq, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Db } from '../../db/client';
import {
  attempts,
  type Difficulty,
  DIFFICULTIES,
  domains,
  examQuestions,
  examSections,
  exams,
  questions,
  topics,
  users,
} from '../../db/schema';
import type { AuthUser } from '../../lib/access';
import { AppError } from '../../lib/app-error';
import { offsetOf, paginated } from '../../lib/pagination';
import { countAll, matchesSearch, qualified } from '../../lib/sql';
import { paginationFields, zId } from '../../lib/validation';
import { findInProgress } from '../attempts/service';

export const catalogQuery = z.strictObject({
  ...paginationFields,
  topicId: zId().optional(),
  /** Searches the exam title. */
  q: z.string().trim().max(200).optional(),
});

type CatalogQuery = z.infer<typeof catalogQuery>;

const catalogColumns = {
  id: exams.id,
  title: exams.title,
  description: exams.description,
  durationMinutes: exams.durationMinutes,
  breakMinutes: exams.breakMinutes,
  passingScore: exams.passingScore,
  publishedAt: exams.publishedAt,
  topicId: topics.id,
  topicName: topics.name,
  ownerId: users.id,
  ownerName: users.fullName,
  questionCount: sql<number>`(SELECT count(*) FROM ${examQuestions} WHERE ${qualified(examQuestions.examId)} = ${qualified(exams.id)})`,
  sectionCount: sql<number>`(SELECT count(*) FROM ${examSections} WHERE ${qualified(examSections.examId)} = ${qualified(exams.id)})`,
};

function selectCatalog<T extends Record<string, SQL>>(db: Db, extra: T) {
  return db
    .select({ ...catalogColumns, ...extra })
    .from(exams)
    .innerJoin(topics, eq(topics.id, exams.topicId))
    .innerJoin(users, eq(users.id, exams.ownerId));
}

function toCatalogExam<
  T extends {
    topicId: string;
    topicName: string;
    ownerId: string;
    ownerName: string;
  },
>({ topicId, topicName, ownerId, ownerName, ...exam }: T) {
  return {
    ...exam,
    topic: { id: topicId, name: topicName },
    owner: { id: ownerId, fullName: ownerName },
  };
}

/** Question counts per domain and per difficulty, from (domain, difficulty) groups. */
function breakdownOf(
  mix: {
    domainId: string | null;
    domainName: string | null;
    difficulty: Difficulty;
    questionCount: number;
  }[],
) {
  const byDomain = new Map<
    string | null,
    { domainId: string | null; name: string; questionCount: number }
  >();
  const byDifficulty = new Map<Difficulty, number>();
  for (const row of mix) {
    const domain = byDomain.get(row.domainId) ?? {
      domainId: row.domainId,
      name: row.domainName ?? 'Unassigned',
      questionCount: 0,
    };
    domain.questionCount += row.questionCount;
    byDomain.set(row.domainId, domain);
    byDifficulty.set(
      row.difficulty,
      (byDifficulty.get(row.difficulty) ?? 0) + row.questionCount,
    );
  }
  return {
    domains: [...byDomain.values()],
    difficulties: DIFFICULTIES.flatMap((difficulty) => {
      const questionCount = byDifficulty.get(difficulty);
      return questionCount ? [{ difficulty, questionCount }] : [];
    }),
  };
}

/** Published exams, visible to every signed-in user. Never exposes question content. */
export async function listCatalog(db: Db, query: CatalogQuery) {
  const where = and(
    eq(exams.status, 'PUBLISHED'),
    query.topicId ? eq(exams.topicId, query.topicId) : undefined,
    query.q ? matchesSearch(exams.searchText, query.q) : undefined,
  );
  const rows = await selectCatalog(db, {})
    .where(where)
    .orderBy(desc(exams.publishedAt), desc(exams.id))
    .limit(query.limit)
    .offset(offsetOf(query));
  const [{ total }] = await db
    .select({ total: countAll() })
    .from(exams)
    .where(where);
  return paginated(rows.map(toCatalogExam), total, query);
}

/** Exam overview before starting, plus the user's in-progress attempt (to offer "resume"). */
export async function getCatalogExam(db: Db, user: AuthUser, examId: string) {
  const [exam] = await selectCatalog(db, {
    totalPoints: sql<number>`(SELECT coalesce(sum(${qualified(examQuestions.points)}), 0) FROM ${examQuestions} WHERE ${qualified(examQuestions.examId)} = ${qualified(exams.id)})`,
    myAttemptCount: sql<number>`(SELECT count(*) FROM ${attempts} WHERE ${qualified(attempts.examId)} = ${qualified(exams.id)} AND ${qualified(attempts.userId)} = ${user.id})`,
  }).where(and(eq(exams.id, examId), eq(exams.status, 'PUBLISHED')));
  if (!exam) throw AppError.notFound('Exam');

  const sections = await db
    .select({
      id: examSections.id,
      title: examSections.title,
      order: examSections.order,
      instructions: examSections.instructions,
      durationMinutes: examSections.durationMinutes,
      questionCount: sql<number>`(SELECT count(*) FROM ${examQuestions} WHERE ${qualified(examQuestions.sectionId)} = ${qualified(examSections.id)})`,
    })
    .from(examSections)
    .where(eq(examSections.examId, examId))
    .orderBy(
      asc(examSections.order),
      asc(examSections.createdAt),
      asc(examSections.id),
    );
  const mix = await db
    .select({
      domainId: domains.id,
      domainName: domains.name,
      difficulty: questions.difficulty,
      questionCount: count(),
    })
    .from(examQuestions)
    .innerJoin(questions, eq(questions.id, examQuestions.questionId))
    .leftJoin(domains, eq(domains.id, questions.domainId))
    .where(eq(examQuestions.examId, examId))
    .groupBy(domains.id, questions.difficulty)
    .orderBy(asc(domains.order));
  const inProgress = await findInProgress(db, user.id, examId);

  const { totalPoints, myAttemptCount, ...summary } = exam;
  return {
    ...toCatalogExam(summary),
    totalPoints,
    sections,
    breakdown: breakdownOf(mix),
    myAttemptCount,
    inProgressAttemptId: inProgress?.id ?? null,
  };
}
