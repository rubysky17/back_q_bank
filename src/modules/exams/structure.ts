import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Db } from '../../db/client';
import { examQuestions, examSections, questions } from '../../db/schema';
import type { AuthUser } from '../../lib/access';
import { AppError } from '../../lib/app-error';
import { inList } from '../../lib/sql';
import { uuidv7 } from '../../lib/uuidv7';
import { zId, zIdList } from '../../lib/validation';
import { examDetail, findEditableExam, sectionInputSchema } from './service';

export const createSectionSchema = sectionInputSchema;
export const updateSectionSchema = sectionInputSchema.partial();

export const reorderSectionsSchema = z.strictObject({
  /** Every section id of the exam, in the new order. */
  sectionIds: zIdList('sectionIds'),
});

export const addExamQuestionsSchema = z.strictObject({
  /** Questions from the exam owner's bank, same topic as the exam. Appended in this order. */
  questionIds: zIdList('questionIds', 500),
  /** Points per question (default 1). */
  points: z.number().int().min(1).max(100).optional(),
});

export const updateExamQuestionSchema = z.strictObject({
  points: z.number().int().min(1).max(100).optional(),
  /** Moves the question to the end of another section of the same exam. */
  sectionId: zId().optional(),
});

export const reorderQuestionsSchema = z.strictObject({
  /** Every question id of the section, in the new order. */
  questionIds: zIdList('questionIds'),
});

type CreateSectionInput = z.infer<typeof createSectionSchema>;
type UpdateSectionInput = z.infer<typeof updateSectionSchema>;
type ReorderSectionsInput = z.infer<typeof reorderSectionsSchema>;
type AddExamQuestionsInput = z.infer<typeof addExamQuestionsSchema>;
type UpdateExamQuestionInput = z.infer<typeof updateExamQuestionSchema>;
type ReorderQuestionsInput = z.infer<typeof reorderQuestionsSchema>;

function sameIds(expected: string[], actual: string[]) {
  return (
    expected.length === actual.length &&
    new Set([...expected, ...actual]).size === expected.length
  );
}

/** `[{ id, ord }]` as one JSON parameter: reorders stay a single statement whatever the size. */
const orderJson = (ids: string[]) =>
  JSON.stringify(ids.map((id, index) => ({ id, ord: index + 1 })));

/** Sections and the questions placed in them. Every change requires a DRAFT exam. */
export async function addSection(
  db: Db,
  user: AuthUser,
  examId: string,
  input: CreateSectionInput,
) {
  await findEditableExam(db, user, examId);
  const [{ max }] = await db
    .select({ max: sql<number>`coalesce(max(${examSections.order}), 0)` })
    .from(examSections)
    .where(eq(examSections.examId, examId));
  await db.insert(examSections).values({
    examId,
    title: input.title,
    instructions: input.instructions,
    order: max + 1,
  });
  return examDetail(db, examId);
}

export async function updateSection(
  db: Db,
  user: AuthUser,
  examId: string,
  sectionId: string,
  input: UpdateSectionInput,
) {
  await findEditableExam(db, user, examId);
  await findSection(db, examId, sectionId);
  await db
    .update(examSections)
    .set({ title: input.title, instructions: input.instructions })
    .where(eq(examSections.id, sectionId));
  return examDetail(db, examId);
}

/** Removes the section and takes its questions out of the exam (they stay in the bank). */
export async function removeSection(
  db: Db,
  user: AuthUser,
  examId: string,
  sectionId: string,
) {
  const exam = await findEditableExam(db, user, examId);
  await findSection(db, examId, sectionId);
  if (exam._count.sections <= 1) {
    throw AppError.conflict(
      'LAST_SECTION',
      'An exam needs at least one section',
    );
  }
  await db.delete(examSections).where(eq(examSections.id, sectionId));
  return examDetail(db, examId);
}

export async function reorderSections(
  db: Db,
  user: AuthUser,
  examId: string,
  input: ReorderSectionsInput,
) {
  await findEditableExam(db, user, examId);
  const sections = await db
    .select({ id: examSections.id })
    .from(examSections)
    .where(eq(examSections.examId, examId));
  if (
    !sameIds(
      sections.map((section) => section.id),
      input.sectionIds,
    )
  ) {
    throw AppError.badRequest(
      'INVALID_ORDER',
      'sectionIds must list every section of the exam exactly once',
    );
  }
  await db.run(sql`
    UPDATE "ExamSection" SET "order" = v.ord, "updatedAt" = ${Date.now()}
    FROM (SELECT value ->> 'id' AS id, value ->> 'ord' AS ord FROM json_each(${orderJson(input.sectionIds)})) AS v
    WHERE "ExamSection"."id" = v.id AND "ExamSection"."examId" = ${examId}`);
  return examDetail(db, examId);
}

/**
 * Appends questions to a section. They must come from the exam owner's bank and the exam's topic,
 * otherwise a host could read another host's answers through the review screen.
 */
export async function addQuestions(
  db: Db,
  user: AuthUser,
  examId: string,
  sectionId: string,
  input: AddExamQuestionsInput,
) {
  const exam = await findEditableExam(db, user, examId);
  await findSection(db, examId, sectionId);

  const found = await db
    .select({
      id: questions.id,
      ownerId: questions.ownerId,
      topicId: questions.topicId,
    })
    .from(questions)
    .where(inList(questions.id, input.questionIds));
  const usable = new Map(
    found
      .filter((question) => question.ownerId === exam.ownerId)
      .map((question) => [question.id, question]),
  );
  const missing = input.questionIds.filter((id) => !usable.has(id));
  if (missing.length > 0) {
    throw AppError.badRequest(
      'QUESTIONS_NOT_FOUND',
      `${missing.length} question(s) were not found in the exam owner's bank`,
      { questionIds: missing },
    );
  }
  const otherTopic = input.questionIds.filter(
    (id) => usable.get(id)?.topicId !== exam.topicId,
  );
  if (otherTopic.length > 0) {
    throw AppError.badRequest(
      'QUESTION_TOPIC_MISMATCH',
      `${otherTopic.length} question(s) belong to a different topic than the exam`,
      { questionIds: otherTopic },
    );
  }

  const already = await db
    .select({ questionId: examQuestions.questionId })
    .from(examQuestions)
    .where(
      and(
        eq(examQuestions.examId, examId),
        inList(examQuestions.questionId, input.questionIds),
      ),
    );
  if (already.length > 0) {
    throw AppError.conflict(
      'QUESTION_ALREADY_IN_EXAM',
      `${already.length} question(s) are already in this exam`,
      { questionIds: already.map((item) => item.questionId) },
    );
  }

  // Up to 500 rows: insert from one JSON parameter (D1 allows 100 bound parameters per statement).
  const start = await nextQuestionOrder(db, sectionId);
  const rows = input.questionIds.map((questionId, index) => ({
    id: uuidv7(),
    questionId,
    order: start + index,
  }));
  await db.run(sql`
    INSERT INTO "ExamQuestion" ("id", "examId", "sectionId", "questionId", "order", "points", "createdAt")
    SELECT value ->> 'id', ${examId}, ${sectionId}, value ->> 'questionId', value ->> 'order',
           ${input.points ?? 1}, ${Date.now()}
    FROM json_each(${JSON.stringify(rows)})`);
  return examDetail(db, examId);
}

export async function updateExamQuestion(
  db: Db,
  user: AuthUser,
  examId: string,
  questionId: string,
  input: UpdateExamQuestionInput,
) {
  await findEditableExam(db, user, examId);
  const item = await findExamQuestion(db, examId, questionId);

  let move: { sectionId: string; order: number } | undefined;
  if (input.sectionId && input.sectionId !== item.sectionId) {
    await findSection(db, examId, input.sectionId);
    move = {
      sectionId: input.sectionId,
      order: await nextQuestionOrder(db, input.sectionId),
    };
  }
  // Nothing to change (e.g. `{}` or the same section): a no-op, like before.
  if (input.points !== undefined || move) {
    await db
      .update(examQuestions)
      .set({ points: input.points, ...move })
      .where(eq(examQuestions.id, item.id));
  }
  return examDetail(db, examId);
}

/** Takes the question out of the exam; it stays in the question bank. */
export async function removeExamQuestion(
  db: Db,
  user: AuthUser,
  examId: string,
  questionId: string,
) {
  await findEditableExam(db, user, examId);
  const item = await findExamQuestion(db, examId, questionId);
  await db.delete(examQuestions).where(eq(examQuestions.id, item.id));
  return examDetail(db, examId);
}

export async function reorderQuestions(
  db: Db,
  user: AuthUser,
  examId: string,
  sectionId: string,
  input: ReorderQuestionsInput,
) {
  await findEditableExam(db, user, examId);
  await findSection(db, examId, sectionId);
  const items = await db
    .select({ id: examQuestions.id, questionId: examQuestions.questionId })
    .from(examQuestions)
    .where(eq(examQuestions.sectionId, sectionId));
  if (
    !sameIds(
      items.map((item) => item.questionId),
      input.questionIds,
    )
  ) {
    throw AppError.badRequest(
      'INVALID_ORDER',
      'questionIds must list every question of the section exactly once',
    );
  }
  const idByQuestion = new Map(items.map((item) => [item.questionId, item.id]));
  const itemIds = input.questionIds.map((id) => idByQuestion.get(id)!);
  await db.run(sql`
    UPDATE "ExamQuestion" SET "order" = v.ord
    FROM (SELECT value ->> 'id' AS id, value ->> 'ord' AS ord FROM json_each(${orderJson(itemIds)})) AS v
    WHERE "ExamQuestion"."id" = v.id AND "ExamQuestion"."sectionId" = ${sectionId}`);
  return examDetail(db, examId);
}

async function findSection(db: Db, examId: string, sectionId: string) {
  const [section] = await db
    .select({ id: examSections.id })
    .from(examSections)
    .where(
      and(eq(examSections.id, sectionId), eq(examSections.examId, examId)),
    );
  if (!section) throw AppError.notFound('Section');
  return section;
}

async function findExamQuestion(db: Db, examId: string, questionId: string) {
  const [item] = await db
    .select({ id: examQuestions.id, sectionId: examQuestions.sectionId })
    .from(examQuestions)
    .where(
      and(
        eq(examQuestions.examId, examId),
        eq(examQuestions.questionId, questionId),
      ),
    );
  if (!item) throw AppError.notFound('Question in this exam');
  return item;
}

async function nextQuestionOrder(db: Db, sectionId: string) {
  const [{ max }] = await db
    .select({ max: sql<number>`coalesce(max(${examQuestions.order}), 0)` })
    .from(examQuestions)
    .where(eq(examQuestions.sectionId, sectionId));
  return max + 1;
}
