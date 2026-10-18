import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Db } from '../../db/client';
import {
  attempts,
  caseStudies,
  domains,
  examQuestions,
  examSections,
  EXAM_STATUSES,
  exams,
  type QuestionMedia,
  questions,
  topics,
} from '../../db/schema';
import { assertOwner, type AuthUser, ownedBy } from '../../lib/access';
import { AppError } from '../../lib/app-error';
import { offsetOf, paginated } from '../../lib/pagination';
import { countAll, qualified } from '../../lib/sql';
import { searchKey } from '../../lib/slugify';
import { uuidv7 } from '../../lib/uuidv7';
import { paginationFields, zId, zName } from '../../lib/validation';
import { getQuestionTypeHandler } from '../questions/question-types';

export const sectionInputSchema = z.strictObject({
  /** e.g. "Section 1" */
  title: zName(200),
  instructions: z.string().max(5000).nullish(),
  /** Time budget of the section in minutes. When every section has one, the exam is taken section by section. */
  durationMinutes: z.number().int().min(1).max(600).nullish(),
});

export const createExamSchema = z.strictObject({
  topicId: zId(),
  /** e.g. "PMP Mock Test 1" */
  title: zName(200),
  description: z.string().max(5000).nullish(),
  /** Total time in minutes; null or omitted = untimed. */
  durationMinutes: z.number().int().min(1).max(1440).nullish(),
  /** Optional break between timed sections, in minutes; null or omitted = no break. */
  breakMinutes: z.number().int().min(1).max(120).nullish(),
  /** Pass mark in percent; null or omitted = no pass/fail. */
  passingScore: z.number().int().min(0).max(100).nullish(),
  /** Shuffle question order inside each section for every attempt. */
  shuffleQuestions: z.boolean().optional(),
  /** Shuffle answer options for every attempt. */
  shuffleOptions: z.boolean().optional(),
  /** Initial sections. Omit for an exam without sections (a single default section is created). */
  sections: z.array(sectionInputSchema).min(1).max(20).optional(),
});
export const updateExamSchema = createExamSchema
  .omit({ topicId: true, sections: true })
  .partial();

export const listExamsQuery = z.strictObject({
  ...paginationFields,
  status: z.enum(EXAM_STATUSES).optional(),
  topicId: zId().optional(),
});

type CreateExamInput = z.infer<typeof createExamSchema>;
type UpdateExamInput = z.infer<typeof updateExamSchema>;
type ListExamsQuery = z.infer<typeof listExamsQuery>;

const summaryColumns = {
  id: exams.id,
  ownerId: exams.ownerId,
  topicId: exams.topicId,
  title: exams.title,
  description: exams.description,
  status: exams.status,
  durationMinutes: exams.durationMinutes,
  breakMinutes: exams.breakMinutes,
  passingScore: exams.passingScore,
  shuffleQuestions: exams.shuffleQuestions,
  shuffleOptions: exams.shuffleOptions,
  publishedAt: exams.publishedAt,
  createdAt: exams.createdAt,
  updatedAt: exams.updatedAt,
  topicName: topics.name,
  sectionCount: sql<number>`(SELECT count(*) FROM ${examSections} WHERE ${qualified(examSections.examId)} = ${qualified(exams.id)})`,
  questionCount: sql<number>`(SELECT count(*) FROM ${examQuestions} WHERE ${qualified(examQuestions.examId)} = ${qualified(exams.id)})`,
  attemptCount: sql<number>`(SELECT count(*) FROM ${attempts} WHERE ${qualified(attempts.examId)} = ${qualified(exams.id)})`,
};

function selectSummaries(db: Db) {
  return db
    .select(summaryColumns)
    .from(exams)
    .innerJoin(topics, eq(topics.id, exams.topicId));
}

type SummaryRow = Awaited<ReturnType<typeof selectSummaries>>[number];

function toSummary({
  topicName,
  sectionCount,
  questionCount,
  attemptCount,
  ...exam
}: SummaryRow) {
  return {
    ...exam,
    topic: { id: exam.topicId, name: topicName },
    _count: {
      sections: sectionCount,
      questions: questionCount,
      attempts: attemptCount,
    },
  };
}

export type ExamSummary = ReturnType<typeof toSummary>;

/** Sections in order, each with its questions (including the host-side definition and answers). */
export async function loadSections(db: Db, examId: string) {
  const rows = await db
    .select({
      sectionId: examSections.id,
      sectionTitle: examSections.title,
      sectionOrder: examSections.order,
      instructions: examSections.instructions,
      durationMinutes: examSections.durationMinutes,
      questionId: examQuestions.questionId,
      order: examQuestions.order,
      points: examQuestions.points,
      sourceNumber: examQuestions.sourceNumber,
      type: questions.type,
      difficulty: questions.difficulty,
      content: questions.content,
      explanation: questions.explanation,
      definition: questions.definition,
      media: questions.media,
      version: questions.version,
      domainId: domains.id,
      domainName: domains.name,
      caseStudyTitle: caseStudies.title,
      caseStudyContent: caseStudies.content,
    })
    .from(examSections)
    .leftJoin(examQuestions, eq(examQuestions.sectionId, examSections.id))
    .leftJoin(questions, eq(questions.id, examQuestions.questionId))
    .leftJoin(domains, eq(domains.id, questions.domainId))
    .leftJoin(caseStudies, eq(caseStudies.id, questions.caseStudyId))
    .where(eq(examSections.examId, examId))
    .orderBy(
      asc(examSections.order),
      asc(examSections.createdAt),
      asc(examSections.id),
      asc(examQuestions.order),
      asc(examQuestions.createdAt),
      asc(examQuestions.id),
    );

  const sections: {
    id: string;
    title: string;
    order: number;
    instructions: string | null;
    durationMinutes: number | null;
    questions: {
      questionId: string;
      order: number;
      points: number;
      sourceNumber: number | null;
      question: {
        id: string;
        type: NonNullable<(typeof rows)[number]['type']>;
        difficulty: NonNullable<(typeof rows)[number]['difficulty']>;
        content: string;
        explanation: string | null;
        definition: unknown;
        media: QuestionMedia[];
        version: number;
        domain: { id: string; name: string } | null;
        caseStudy: { title: string; content: string } | null;
      };
    }[];
  }[] = [];
  for (const row of rows) {
    let section = sections.at(-1);
    if (section?.id !== row.sectionId) {
      section = {
        id: row.sectionId,
        title: row.sectionTitle,
        order: row.sectionOrder,
        instructions: row.instructions,
        durationMinutes: row.durationMinutes,
        questions: [],
      };
      sections.push(section);
    }
    if (row.questionId === null) continue;
    section.questions.push({
      questionId: row.questionId,
      order: row.order!,
      points: row.points!,
      sourceNumber: row.sourceNumber,
      question: {
        id: row.questionId,
        type: row.type!,
        difficulty: row.difficulty!,
        content: row.content!,
        explanation: row.explanation,
        definition: row.definition,
        media: row.media ?? [],
        version: row.version!,
        domain:
          row.domainId && row.domainName !== null
            ? { id: row.domainId, name: row.domainName }
            : null,
        caseStudy:
          row.caseStudyTitle !== null && row.caseStudyContent !== null
            ? { title: row.caseStudyTitle, content: row.caseStudyContent }
            : null,
      },
    });
  }
  return sections;
}

export async function examDetail(db: Db, id: string) {
  const [row] = await selectSummaries(db).where(eq(exams.id, id));
  if (!row) throw AppError.notFound('Exam');
  const sections = await loadSections(db, id);
  const items = sections.flatMap((section) => section.questions);
  return {
    ...toSummary(row),
    sections,
    questionCount: items.length,
    totalPoints: items.reduce((sum, item) => sum + item.points, 0),
  };
}

type ExamDetail = Awaited<ReturnType<typeof examDetail>>;

export async function listExams(db: Db, user: AuthUser, query: ListExamsQuery) {
  const where = and(
    ownedBy(exams.ownerId, user),
    query.status ? eq(exams.status, query.status) : undefined,
    query.topicId ? eq(exams.topicId, query.topicId) : undefined,
  );
  const rows = await selectSummaries(db)
    .where(where)
    .orderBy(desc(exams.updatedAt), desc(exams.id))
    .limit(query.limit)
    .offset(offsetOf(query));
  const [{ total }] = await db
    .select({ total: countAll() })
    .from(exams)
    .where(where);
  return paginated(rows.map(toSummary), total, query);
}

/** An exam always starts with at least one section, created in the same batch. */
export async function createExam(
  db: Db,
  user: AuthUser,
  input: CreateExamInput,
) {
  const [topic] = await db
    .select({ id: topics.id })
    .from(topics)
    .where(eq(topics.id, input.topicId));
  if (!topic) throw AppError.notFound('Topic');

  const sections: {
    title: string;
    instructions?: string | null;
    durationMinutes?: number | null;
  }[] = input.sections ?? [{ title: 'Section 1' }];
  const examId = uuidv7();
  // One batch: the exam never exists without its sections.
  await db.batch([
    db.insert(exams).values({
      id: examId,
      ownerId: user.id,
      topicId: input.topicId,
      title: input.title,
      searchText: searchKey(input.title),
      description: input.description,
      durationMinutes: input.durationMinutes,
      breakMinutes: input.breakMinutes,
      passingScore: input.passingScore,
      shuffleQuestions: input.shuffleQuestions,
      shuffleOptions: input.shuffleOptions,
    }),
    db.insert(examSections).values(
      sections.map((section, index) => ({
        examId,
        title: section.title,
        instructions: section.instructions ?? null,
        durationMinutes: section.durationMinutes ?? null,
        order: index + 1,
      })),
    ),
  ]);
  return examDetail(db, examId);
}

export async function getExam(db: Db, user: AuthUser, id: string) {
  return assertOwner(await examDetail(db, id), user, 'Exam');
}

export async function updateExam(
  db: Db,
  user: AuthUser,
  id: string,
  input: UpdateExamInput,
) {
  await findEditableExam(db, user, id);
  await db
    .update(exams)
    .set({
      title: input.title,
      searchText:
        input.title === undefined ? undefined : searchKey(input.title),
      description: input.description,
      durationMinutes: input.durationMinutes,
      breakMinutes: input.breakMinutes,
      passingScore: input.passingScore,
      shuffleQuestions: input.shuffleQuestions,
      shuffleOptions: input.shuffleOptions,
    })
    .where(eq(exams.id, id));
  return examDetail(db, id);
}

export async function removeExam(db: Db, user: AuthUser, id: string) {
  const exam = await findOwnedExam(db, user, id);
  if (exam._count.attempts > 0) {
    throw AppError.conflict(
      'EXAM_HAS_ATTEMPTS',
      'This exam already has attempts; archive it instead of deleting',
    );
  }
  await db.delete(exams).where(eq(exams.id, id));
}

/** DRAFT → PUBLISHED after checking every section has questions and every question is valid. */
export async function publishExam(db: Db, user: AuthUser, id: string) {
  const exam = assertOwner(await examDetail(db, id), user, 'Exam');
  if (exam.status !== 'DRAFT') {
    throw AppError.conflict(
      'INVALID_STATUS',
      `Only draft exams can be published (current status: ${exam.status})`,
    );
  }

  const issues = publishIssues(exam);
  if (issues.length > 0) {
    const more = issues.length > 1 ? ` (+${issues.length - 1} more)` : '';
    throw AppError.conflict(
      'EXAM_NOT_PUBLISHABLE',
      `${issues[0]}${more}`,
      issues,
    );
  }

  const [published] = await db
    .update(exams)
    .set({ status: 'PUBLISHED', publishedAt: new Date() })
    .where(and(eq(exams.id, id), eq(exams.status, 'DRAFT')))
    .returning({
      status: exams.status,
      publishedAt: exams.publishedAt,
      updatedAt: exams.updatedAt,
    });
  if (!published) {
    throw AppError.conflict('INVALID_STATUS', 'Exam status changed, retry');
  }
  // Only these three fields changed: no need to read the whole exam again.
  return { ...exam, ...published };
}

/** Back to DRAFT so it can be edited. Attempts already started keep their snapshot. */
export async function unpublishExam(db: Db, user: AuthUser, id: string) {
  await findOwnedExam(db, user, id);
  await db
    .update(exams)
    .set({ status: 'DRAFT', publishedAt: null })
    .where(eq(exams.id, id));
  return examDetail(db, id);
}

/** Hidden from the catalog; attempt history is kept. */
export async function archiveExam(db: Db, user: AuthUser, id: string) {
  await findOwnedExam(db, user, id);
  await db.update(exams).set({ status: 'ARCHIVED' }).where(eq(exams.id, id));
  return examDetail(db, id);
}

export async function findOwnedExam(db: Db, user: AuthUser, id: string) {
  const [row] = await selectSummaries(db).where(eq(exams.id, id));
  return toSummary(assertOwner(row, user, 'Exam'));
}

/** Exam structure and settings can only change while the exam is a draft. */
export async function findEditableExam(db: Db, user: AuthUser, id: string) {
  const exam = await findOwnedExam(db, user, id);
  if (exam.status !== 'DRAFT') {
    throw AppError.conflict(
      'EXAM_NOT_EDITABLE',
      'Only draft exams can be edited; unpublish it first',
    );
  }
  return exam;
}

function publishIssues(exam: ExamDetail): string[] {
  const issues: string[] = [];
  if (exam.questionCount === 0) issues.push('The exam has no questions');
  for (const section of exam.sections) {
    if (section.questions.length === 0) {
      issues.push(`Section "${section.title}" has no questions`);
    }
    for (const { question } of section.questions) {
      try {
        getQuestionTypeHandler(question.type).parseDefinition(
          question.definition,
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'invalid';
        issues.push(`Question ${question.id} is invalid: ${reason}`);
      }
    }
  }
  return issues;
}
