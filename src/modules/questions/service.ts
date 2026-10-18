import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Db } from '../../db/client';
import {
  caseStudies,
  DIFFICULTIES,
  domains,
  examQuestions,
  MEDIA_PLACEMENTS,
  QUESTION_TYPES,
  questions,
  topics,
} from '../../db/schema';
import { assertOwner, type AuthUser, ownedBy } from '../../lib/access';
import { AppError } from '../../lib/app-error';
import { offsetOf, paginated } from '../../lib/pagination';
import { countAll, matchesSearch, qualified } from '../../lib/sql';
import { searchKey } from '../../lib/slugify';
import { paginationFields, zId, zName } from '../../lib/validation';
import { getQuestionTypeHandler } from './question-types';

const mediaSchema = z.strictObject({
  /** Relative to the API origin (`/media/...`) or an absolute https URL. */
  url: z.string().trim().regex(/^(\/media\/|https:\/\/)\S+$/).max(500),
  alt: z.string().trim().max(300),
  placement: z.enum(MEDIA_PLACEMENTS),
  width: z.number().int().positive().max(20_000),
  height: z.number().int().positive().max(20_000),
});

export const createQuestionSchema = z.strictObject({
  topicId: zId(),
  /** Must belong to `topicId`. Send null to clear it on update. */
  domainId: zId().nullish(),
  /** Shared scenario; must belong to `topicId`. Send null to clear it on update. */
  caseStudyId: zId().nullish(),
  /** Images shown with the stem (CONTENT) or the explanation (EXPLANATION). */
  media: z.array(mediaSchema).max(10).optional(),
  /** Defaults to SINGLE_CHOICE (the only supported type for now). */
  type: z.enum(QUESTION_TYPES).optional(),
  /** Defaults to MEDIUM. */
  difficulty: z.enum(DIFFICULTIES).optional(),
  /** The question stem (plain text or markdown). */
  content: zName(10_000),
  /** Shown to the test taker after submitting. */
  explanation: z.string().max(10_000).nullish(),
  /**
   * Type-specific payload, validated by the type's handler. SINGLE_CHOICE: 2-10 options, exactly one with
   * isCorrect=true. Omit option ids for new options; keep them when editing.
   */
  definition: z.record(z.string(), z.unknown()),
});
export const updateQuestionSchema = createQuestionSchema.partial();

export const listQuestionsQuery = z.strictObject({
  ...paginationFields,
  topicId: zId().optional(),
  domainId: zId().optional(),
  difficulty: z.enum(DIFFICULTIES).optional(),
  type: z.enum(QUESTION_TYPES).optional(),
  /** Searches the question content. */
  q: z.string().trim().max(200).optional(),
});

type CreateQuestionInput = z.infer<typeof createQuestionSchema>;
type UpdateQuestionInput = z.infer<typeof updateQuestionSchema>;
type ListQuestionsQuery = z.infer<typeof listQuestionsQuery>;

const questionColumns = {
  id: questions.id,
  ownerId: questions.ownerId,
  topicId: questions.topicId,
  domainId: questions.domainId,
  caseStudyId: questions.caseStudyId,
  type: questions.type,
  difficulty: questions.difficulty,
  content: questions.content,
  explanation: questions.explanation,
  media: questions.media,
  definition: questions.definition,
  version: questions.version,
  createdAt: questions.createdAt,
  updatedAt: questions.updatedAt,
  topicName: topics.name,
  domainName: domains.name,
  examQuestionCount: sql<number>`(SELECT count(*) FROM ${examQuestions} WHERE ${qualified(examQuestions.questionId)} = ${qualified(questions.id)})`,
};

function selectQuestions(db: Db) {
  return db
    .select(questionColumns)
    .from(questions)
    .innerJoin(topics, eq(topics.id, questions.topicId))
    .leftJoin(domains, eq(domains.id, questions.domainId));
}

type QuestionRow = Awaited<ReturnType<typeof selectQuestions>>[number];

function toQuestion({
  topicName,
  domainName,
  examQuestionCount,
  ...question
}: QuestionRow) {
  return {
    ...question,
    topic: { id: question.topicId, name: topicName },
    domain:
      question.domainId && domainName !== null
        ? { id: question.domainId, name: domainName }
        : null,
    _count: { examQuestions: examQuestionCount },
  };
}

export async function listQuestions(
  db: Db,
  user: AuthUser,
  query: ListQuestionsQuery,
) {
  const where = and(
    ownedBy(questions.ownerId, user),
    query.topicId ? eq(questions.topicId, query.topicId) : undefined,
    query.domainId ? eq(questions.domainId, query.domainId) : undefined,
    query.difficulty ? eq(questions.difficulty, query.difficulty) : undefined,
    query.type ? eq(questions.type, query.type) : undefined,
    query.q ? matchesSearch(questions.searchText, query.q) : undefined,
  );
  const rows = await selectQuestions(db)
    .where(where)
    .orderBy(desc(questions.createdAt), desc(questions.id))
    .limit(query.limit)
    .offset(offsetOf(query));
  const [{ total }] = await db
    .select({ total: countAll() })
    .from(questions)
    .where(where);
  return paginated(rows.map(toQuestion), total, query);
}

export async function getQuestion(db: Db, user: AuthUser, id: string) {
  const [row] = await selectQuestions(db).where(eq(questions.id, id));
  return toQuestion(assertOwner(row, user, 'Question'));
}

export async function createQuestion(
  db: Db,
  user: AuthUser,
  input: CreateQuestionInput,
) {
  const type = input.type ?? 'SINGLE_CHOICE';
  const definition = getQuestionTypeHandler(type).parseDefinition(
    input.definition,
  );
  await assertTopicAndDomain(db, input.topicId, input.domainId ?? null);
  await assertCaseStudy(db, input.topicId, input.caseStudyId ?? null);

  const [{ id }] = await db
    .insert(questions)
    .values({
      ownerId: user.id,
      topicId: input.topicId,
      domainId: input.domainId ?? null,
      caseStudyId: input.caseStudyId ?? null,
      type,
      difficulty: input.difficulty,
      content: input.content,
      searchText: searchKey(input.content),
      explanation: input.explanation,
      media: input.media,
      definition,
    })
    .returning({ id: questions.id });
  return getQuestion(db, user, id);
}

/** Every edit bumps `version`; attempts already started keep their own snapshot. */
export async function updateQuestion(
  db: Db,
  user: AuthUser,
  id: string,
  input: UpdateQuestionInput,
) {
  const current = await getQuestion(db, user, id);

  const topicId = input.topicId ?? current.topicId;
  if (topicId !== current.topicId && current._count.examQuestions > 0) {
    throw AppError.conflict(
      'QUESTION_IN_USE',
      'A question used in exams cannot move to another topic',
    );
  }
  const domainId =
    input.domainId === undefined ? current.domainId : input.domainId;
  await assertTopicAndDomain(db, topicId, domainId);
  const caseStudyId =
    input.caseStudyId === undefined ? current.caseStudyId : input.caseStudyId;
  await assertCaseStudy(db, topicId, caseStudyId);

  const type = input.type ?? current.type;
  if (type !== current.type && input.definition === undefined) {
    throw AppError.badRequest(
      'DEFINITION_REQUIRED',
      'Changing the question type requires a new definition',
    );
  }
  const definition =
    input.definition === undefined
      ? undefined
      : getQuestionTypeHandler(type).parseDefinition(input.definition);

  const updated = await db
    .update(questions)
    .set({
      topicId,
      domainId,
      caseStudyId,
      type,
      difficulty: input.difficulty,
      content: input.content,
      searchText:
        input.content === undefined ? undefined : searchKey(input.content),
      explanation: input.explanation,
      media: input.media,
      definition,
      version: sql`${questions.version} + 1`,
    })
    .where(eq(questions.id, id))
    .returning({ id: questions.id });
  if (updated.length === 0) throw AppError.notFound('Question');
  return getQuestion(db, user, id);
}

/** Fails with 409 QUESTION_IN_USE while any exam contains the question. */
export async function removeQuestion(db: Db, user: AuthUser, id: string) {
  const question = await getQuestion(db, user, id);
  if (question._count.examQuestions > 0) {
    throw AppError.conflict(
      'QUESTION_IN_USE',
      `Question is used in ${question._count.examQuestions} exam(s); remove it from those exams first`,
    );
  }
  await db.delete(questions).where(eq(questions.id, id));
}

async function assertCaseStudy(
  db: Db,
  topicId: string,
  caseStudyId: string | null,
) {
  if (!caseStudyId) return;
  const [caseStudy] = await db
    .select({ topicId: caseStudies.topicId })
    .from(caseStudies)
    .where(eq(caseStudies.id, caseStudyId));
  if (!caseStudy) throw AppError.notFound('Case study');
  if (caseStudy.topicId !== topicId) {
    throw AppError.badRequest(
      'CASE_STUDY_TOPIC_MISMATCH',
      'The case study does not belong to the question topic',
    );
  }
}

async function assertTopicAndDomain(
  db: Db,
  topicId: string,
  domainId: string | null,
) {
  const [topic] = await db
    .select({ id: topics.id })
    .from(topics)
    .where(eq(topics.id, topicId));
  if (!topic) throw AppError.notFound('Topic');
  if (!domainId) return;

  const [domain] = await db
    .select({ topicId: domains.topicId })
    .from(domains)
    .where(eq(domains.id, domainId));
  if (!domain) throw AppError.notFound('Domain');
  if (domain.topicId !== topicId) {
    throw AppError.badRequest(
      'DOMAIN_TOPIC_MISMATCH',
      'The domain does not belong to the question topic',
    );
  }
}
