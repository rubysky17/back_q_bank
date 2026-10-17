import { and, asc, desc, eq, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Db } from '../../db/client';
import {
  attempts,
  examQuestions,
  examSections,
  exams,
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
      questionCount: sql<number>`(SELECT count(*) FROM ${examQuestions} WHERE ${qualified(examQuestions.sectionId)} = ${qualified(examSections.id)})`,
    })
    .from(examSections)
    .where(eq(examSections.examId, examId))
    .orderBy(
      asc(examSections.order),
      asc(examSections.createdAt),
      asc(examSections.id),
    );
  const inProgress = await findInProgress(db, user.id, examId);

  const { totalPoints, myAttemptCount, ...summary } = exam;
  return {
    ...toCatalogExam(summary),
    totalPoints,
    sections,
    myAttemptCount,
    inProgressAttemptId: inProgress?.id ?? null,
  };
}
