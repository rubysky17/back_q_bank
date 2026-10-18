import { and, asc, count, eq, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import type { Db } from '../../db/client';
import {
  caseStudies,
  DIFFICULTIES,
  domains,
  examQuestions,
  examSections,
  exams,
  questions,
} from '../../db/schema';
import { offsetOf, paginated } from '../../lib/pagination';
import { countAll, matchesSearch } from '../../lib/sql';
import { paginationFields, zId } from '../../lib/validation';

/**
 * Self-study access to the questions of published exams, answers and explanations included.
 * Unlike attempts, nothing is graded or recorded here: the app checks answers locally.
 */
export const bankQuery = z.strictObject({
  ...paginationFields,
  examId: zId().optional(),
  sectionId: zId().optional(),
  domainId: zId().optional(),
  difficulty: z.enum(DIFFICULTIES).optional(),
  /** Searches the question stem. */
  q: z.string().trim().max(200).optional(),
});

type BankQuery = z.infer<typeof bankQuery>;

function whereOf(query: BankQuery): SQL | undefined {
  return and(
    eq(exams.status, 'PUBLISHED'),
    query.examId ? eq(examQuestions.examId, query.examId) : undefined,
    query.sectionId ? eq(examQuestions.sectionId, query.sectionId) : undefined,
    query.domainId ? eq(questions.domainId, query.domainId) : undefined,
    query.difficulty ? eq(questions.difficulty, query.difficulty) : undefined,
    query.q ? matchesSearch(questions.searchText, query.q) : undefined,
  );
}

/** One row per placement of a question in a published exam, in paper order. */
export async function listBankQuestions(db: Db, query: BankQuery) {
  const where = whereOf(query);
  const rows = await db
    .select({
      id: examQuestions.id,
      questionId: questions.id,
      examId: exams.id,
      examTitle: exams.title,
      sectionId: examSections.id,
      sectionTitle: examSections.title,
      sectionOrder: examSections.order,
      order: examQuestions.order,
      sourceNumber: examQuestions.sourceNumber,
      type: questions.type,
      difficulty: questions.difficulty,
      content: questions.content,
      explanation: questions.explanation,
      media: questions.media,
      definition: questions.definition,
      domainId: domains.id,
      domainName: domains.name,
      caseStudyTitle: caseStudies.title,
      caseStudyContent: caseStudies.content,
    })
    .from(examQuestions)
    .innerJoin(exams, eq(exams.id, examQuestions.examId))
    .innerJoin(examSections, eq(examSections.id, examQuestions.sectionId))
    .innerJoin(questions, eq(questions.id, examQuestions.questionId))
    .leftJoin(domains, eq(domains.id, questions.domainId))
    .leftJoin(caseStudies, eq(caseStudies.id, questions.caseStudyId))
    .where(where)
    .orderBy(
      asc(exams.title),
      asc(examSections.order),
      asc(examQuestions.order),
      asc(examQuestions.id),
    )
    .limit(query.limit)
    .offset(offsetOf(query));
  const [{ total }] = await db
    .select({ total: countAll() })
    .from(examQuestions)
    .innerJoin(exams, eq(exams.id, examQuestions.examId))
    .innerJoin(questions, eq(questions.id, examQuestions.questionId))
    .where(where);

  const items = rows.map(
    ({ domainId, domainName, caseStudyTitle, caseStudyContent, ...row }) => ({
      ...row,
      domain:
        domainId && domainName !== null
          ? { id: domainId, name: domainName }
          : null,
      caseStudy:
        caseStudyTitle !== null && caseStudyContent !== null
          ? { title: caseStudyTitle, content: caseStudyContent }
          : null,
    }),
  );
  return paginated(items, total, query);
}

/** What the filter bar offers: published exams with their sections, domains and difficulties in use. */
export async function bankFacets(db: Db) {
  const published = eq(exams.status, 'PUBLISHED');
  const sectionRows = await db
    .select({
      examId: exams.id,
      examTitle: exams.title,
      sectionId: examSections.id,
      sectionTitle: examSections.title,
      sectionOrder: examSections.order,
      questionCount: count(examQuestions.id),
    })
    .from(examSections)
    .innerJoin(exams, eq(exams.id, examSections.examId))
    .leftJoin(examQuestions, eq(examQuestions.sectionId, examSections.id))
    .where(published)
    .groupBy(examSections.id)
    .orderBy(asc(exams.title), asc(examSections.order));

  const domainRows = await db
    .select({
      id: domains.id,
      name: domains.name,
      questionCount: count(),
    })
    .from(examQuestions)
    .innerJoin(exams, eq(exams.id, examQuestions.examId))
    .innerJoin(questions, eq(questions.id, examQuestions.questionId))
    .innerJoin(domains, eq(domains.id, questions.domainId))
    .where(published)
    .groupBy(domains.id)
    .orderBy(asc(domains.order));

  const difficultyRows = await db
    .select({ difficulty: questions.difficulty, questionCount: count() })
    .from(examQuestions)
    .innerJoin(exams, eq(exams.id, examQuestions.examId))
    .innerJoin(questions, eq(questions.id, examQuestions.questionId))
    .where(published)
    .groupBy(questions.difficulty);

  const examsById = new Map<
    string,
    {
      id: string;
      title: string;
      questionCount: number;
      sections: {
        id: string;
        title: string;
        order: number;
        questionCount: number;
      }[];
    }
  >();
  for (const row of sectionRows) {
    const exam = examsById.get(row.examId) ?? {
      id: row.examId,
      title: row.examTitle,
      questionCount: 0,
      sections: [],
    };
    exam.questionCount += row.questionCount;
    exam.sections.push({
      id: row.sectionId,
      title: row.sectionTitle,
      order: row.sectionOrder,
      questionCount: row.questionCount,
    });
    examsById.set(row.examId, exam);
  }

  return {
    exams: [...examsById.values()],
    domains: domainRows,
    difficulties: DIFFICULTIES.flatMap((difficulty) => {
      const row = difficultyRows.find((r) => r.difficulty === difficulty);
      return row ? [row] : [];
    }),
  };
}
