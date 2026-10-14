import { Injectable } from '@nestjs/common';

import { paginated, toSkipTake } from '../../common/dto/pagination.dto.js';
import { AppError } from '../../common/errors/app-error.js';
import type { AuthUser } from '../../common/types/auth-user.js';
import { shuffle } from '../../common/utils/random.js';
import {
  AttemptStatus,
  ExamStatus,
  Prisma,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  getQuestionTypeHandler,
  type QuestionSnapshot,
} from '../questions/question-types/index.js';
import type {
  ListAttemptsQueryDto,
  SaveAnswersDto,
} from './dto/attempts.dto.js';
import { type GradedItem, percentOf, summarize } from './grading.js';

/** Answers are still accepted this long after `expiresAt` to absorb network latency. */
export const ANSWER_GRACE_MS = 30_000;

const attemptSelect = {
  id: true,
  examId: true,
  userId: true,
  examTitle: true,
  status: true,
  passingScore: true,
  startedAt: true,
  expiresAt: true,
  submittedAt: true,
  score: true,
  maxScore: true,
  correctCount: true,
  totalQuestions: true,
  passed: true,
} satisfies Prisma.AttemptSelect;

type AttemptRow = Prisma.AttemptGetPayload<{ select: typeof attemptSelect }>;

function isOverdue(
  attempt: Pick<AttemptRow, 'status' | 'expiresAt'>,
  now = new Date(),
) {
  return (
    attempt.status === AttemptStatus.IN_PROGRESS &&
    attempt.expiresAt !== null &&
    now.getTime() > attempt.expiresAt.getTime() + ANSWER_GRACE_MS
  );
}

const asSnapshot = (value: Prisma.JsonValue) =>
  value as unknown as QuestionSnapshot;

function isUniqueViolation(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

@Injectable()
export class AttemptsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Starts an attempt on a published exam, or resumes the one in progress (double taps and app restarts
   * land on the same attempt). Questions are frozen into snapshots so later edits by the host don't matter.
   */
  async start(user: AuthUser, examId: string) {
    const exam = await this.prisma.exam.findFirst({
      where: { id: examId, status: ExamStatus.PUBLISHED },
      select: {
        id: true,
        title: true,
        durationMinutes: true,
        passingScore: true,
        shuffleQuestions: true,
        shuffleOptions: true,
        sections: {
          orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
          select: {
            id: true,
            title: true,
            order: true,
            questions: {
              orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
              select: {
                points: true,
                question: {
                  select: {
                    id: true,
                    type: true,
                    difficulty: true,
                    content: true,
                    explanation: true,
                    definition: true,
                    version: true,
                    domain: { select: { id: true, name: true } },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!exam) throw AppError.notFound('Exam');

    const resumable = await this.findInProgress(user.id, examId);
    if (resumable) return { resumed: true, ...(await this.view(resumable.id)) };

    let order = 0;
    const rows = exam.sections.flatMap((section) => {
      const items = exam.shuffleQuestions
        ? shuffle(section.questions)
        : section.questions;
      return items.map(({ points, question }) => {
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
          data,
          answerKey,
        };
        return {
          questionId: question.id,
          questionVersion: question.version,
          sectionId: section.id,
          sectionTitle: section.title,
          sectionOrder: section.order,
          order: ++order,
          points,
          snapshot: snapshot as unknown as Prisma.InputJsonValue,
        };
      });
    });
    if (rows.length === 0) {
      throw AppError.conflict('EXAM_EMPTY', 'This exam has no questions');
    }

    const now = new Date();
    try {
      const attempt = await this.prisma.$transaction(async (tx) => {
        const created = await tx.attempt.create({
          data: {
            examId,
            userId: user.id,
            examTitle: exam.title,
            passingScore: exam.passingScore,
            startedAt: now,
            expiresAt: exam.durationMinutes
              ? new Date(now.getTime() + exam.durationMinutes * 60_000)
              : null,
            maxScore: rows.reduce((sum, row) => sum + row.points, 0),
            totalQuestions: rows.length,
          },
          select: { id: true },
        });
        await tx.attemptQuestion.createMany({
          data: rows.map((row) => ({ ...row, attemptId: created.id })),
        });
        return created;
      });
      return { resumed: false, ...(await this.view(attempt.id)) };
    } catch (error) {
      // Another request started the same attempt a moment ago (partial unique index).
      if (isUniqueViolation(error)) {
        const current = await this.findInProgress(user.id, examId);
        if (current) return { resumed: true, ...(await this.view(current.id)) };
      }
      throw error;
    }
  }

  async list(user: AuthUser, query: ListAttemptsQueryDto) {
    await this.expireOverdueForUser(user.id);
    const where: Prisma.AttemptWhereInput = {
      userId: user.id,
      examId: query.examId,
      status: query.status,
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.attempt.findMany({
        where,
        select: attemptSelect,
        orderBy: { startedAt: 'desc' },
        ...toSkipTake(query),
      }),
      this.prisma.attempt.count({ where }),
    ]);
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
  async get(user: AuthUser, attemptId: string) {
    const attempt = await this.findOwned(user, attemptId);
    if (isOverdue(attempt))
      await this.finalize(attempt.id, AttemptStatus.EXPIRED);
    return this.view(attempt.id);
  }

  async saveAnswers(user: AuthUser, attemptId: string, dto: SaveAnswersDto) {
    const attempt = await this.findOwned(user, attemptId);
    this.assertInProgress(attempt);
    if (isOverdue(attempt)) {
      await this.finalize(attempt.id, AttemptStatus.EXPIRED);
      throw AppError.conflict(
        'ATTEMPT_EXPIRED',
        'Time is up; the attempt was submitted automatically',
      );
    }

    const ids = dto.answers.map((answer) => answer.attemptQuestionId);
    if (new Set(ids).size !== ids.length) {
      throw AppError.badRequest(
        'DUPLICATE_ANSWER',
        'Each question can appear only once per request',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      // Row lock: serialises with submit/expiry so no answer lands after grading.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Attempt"
        WHERE id = ${attemptId}::uuid AND status = 'IN_PROGRESS'
        FOR UPDATE`;
      if (locked.length === 0) throw this.closedError();

      const questions = await tx.attemptQuestion.findMany({
        where: { attemptId, id: { in: ids } },
        select: { id: true, snapshot: true },
      });
      const snapshots = new Map(
        questions.map((question) => [
          question.id,
          asSnapshot(question.snapshot),
        ]),
      );
      const unknown = ids.filter((id) => !snapshots.has(id));
      if (unknown.length > 0) {
        throw AppError.badRequest(
          'INVALID_ATTEMPT_QUESTION',
          `${unknown.length} question(s) do not belong to this attempt`,
          { attemptQuestionIds: unknown },
        );
      }

      const now = new Date();
      for (const answer of dto.answers) {
        const data: Prisma.AttemptQuestionUpdateInput = {};
        if (answer.response === null) {
          data.response = Prisma.DbNull;
          data.answeredAt = null;
        } else if (answer.response !== undefined) {
          const snapshot = snapshots.get(answer.attemptQuestionId)!;
          data.response = getQuestionTypeHandler(snapshot.type).parseResponse(
            snapshot.data,
            answer.response,
          ) as Prisma.InputJsonValue;
          data.answeredAt = now;
        }
        if (answer.flagged !== undefined) data.flagged = answer.flagged;
        if (Object.keys(data).length > 0) {
          await tx.attemptQuestion.update({
            where: { id: answer.attemptQuestionId },
            data,
          });
        }
      }
    });

    const [answeredCount, flaggedCount] = await Promise.all([
      this.prisma.attemptQuestion.count({
        where: { attemptId, response: { not: Prisma.DbNull } },
      }),
      this.prisma.attemptQuestion.count({
        where: { attemptId, flagged: true },
      }),
    ]);
    return {
      attemptId,
      saved: ids.length,
      answeredCount,
      flaggedCount,
      serverTime: new Date(),
    };
  }

  /** Idempotent: submitting again (e.g. a retry after a lost response) returns the same result. */
  async submit(user: AuthUser, attemptId: string) {
    const attempt = await this.findOwned(user, attemptId);
    if (attempt.status === AttemptStatus.IN_PROGRESS) {
      await this.finalize(
        attempt.id,
        isOverdue(attempt) ? AttemptStatus.EXPIRED : AttemptStatus.SUBMITTED,
      );
    }
    return this.result(user, attemptId);
  }

  async result(user: AuthUser, attemptId: string) {
    const attempt = await this.findClosed(user, attemptId);
    const questions = await this.prisma.attemptQuestion.findMany({
      where: { attemptId },
      select: {
        sectionId: true,
        sectionTitle: true,
        sectionOrder: true,
        points: true,
        score: true,
        isCorrect: true,
        response: true,
        snapshot: true,
      },
    });
    const items: GradedItem[] = questions.map((question) => {
      const snapshot = asSnapshot(question.snapshot);
      return {
        sectionId: question.sectionId,
        sectionTitle: question.sectionTitle,
        sectionOrder: question.sectionOrder,
        domain: snapshot.domain,
        difficulty: snapshot.difficulty,
        points: question.points,
        score: question.score ?? 0,
        isCorrect: question.isCorrect === true,
        answered: question.response !== null,
      };
    });
    const { overall, sections, domains, difficulties } = summarize(items);

    return {
      attemptId: attempt.id,
      examId: attempt.examId,
      examTitle: attempt.examTitle,
      status: attempt.status,
      startedAt: attempt.startedAt,
      submittedAt: attempt.submittedAt,
      timeSpentSeconds: attempt.submittedAt
        ? Math.round(
            (attempt.submittedAt.getTime() - attempt.startedAt.getTime()) /
              1000,
          )
        : null,
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
  async review(user: AuthUser, attemptId: string) {
    const attempt = await this.findClosed(user, attemptId);
    const questions = await this.prisma.attemptQuestion.findMany({
      where: { attemptId },
      orderBy: { order: 'asc' },
      select: {
        id: true,
        order: true,
        sectionId: true,
        sectionTitle: true,
        sectionOrder: true,
        points: true,
        score: true,
        isCorrect: true,
        response: true,
        flagged: true,
        snapshot: true,
      },
    });
    return {
      attemptId: attempt.id,
      examId: attempt.examId,
      examTitle: attempt.examTitle,
      status: attempt.status,
      questions: questions.map(({ snapshot, ...question }) => {
        const {
          type,
          content,
          difficulty,
          domain,
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
          data,
          answerKey,
          explanation,
        };
      }),
    };
  }

  /** Closes attempts whose time ran out while the user was away (called before listing). */
  async expireOverdueForUser(userId: string) {
    const overdue = await this.prisma.attempt.findMany({
      where: {
        userId,
        status: AttemptStatus.IN_PROGRESS,
        expiresAt: { lt: new Date(Date.now() - ANSWER_GRACE_MS) },
      },
      select: { id: true },
    });
    for (const { id } of overdue) {
      await this.finalize(id, AttemptStatus.EXPIRED);
    }
  }

  /** The user's in-progress attempt on an exam, if its time has not run out. */
  async findInProgress(userId: string, examId: string) {
    const attempt = await this.prisma.attempt.findFirst({
      where: { userId, examId, status: AttemptStatus.IN_PROGRESS },
      select: attemptSelect,
    });
    if (!attempt) return null;
    if (isOverdue(attempt)) {
      await this.finalize(attempt.id, AttemptStatus.EXPIRED);
      return null;
    }
    return attempt;
  }

  /**
   * Grades and closes an attempt. The row lock + status check make it safe to call concurrently
   * (double submit, submit racing with expiry): only the first call grades.
   */
  private async finalize(
    attemptId: string,
    status: typeof AttemptStatus.SUBMITTED | typeof AttemptStatus.EXPIRED,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<
        { maxScore: number; passingScore: number | null }[]
      >`
        SELECT "maxScore", "passingScore" FROM "Attempt"
        WHERE id = ${attemptId}::uuid AND status = 'IN_PROGRESS'
        FOR UPDATE`;
      if (locked.length === 0) return;
      const [{ maxScore, passingScore }] = locked;

      const questions = await tx.attemptQuestion.findMany({
        where: { attemptId },
        select: { id: true, points: true, response: true, snapshot: true },
      });
      const graded = questions.map((question) => {
        if (question.response === null) {
          return { id: question.id, isCorrect: false, score: 0 };
        }
        const snapshot = asSnapshot(question.snapshot);
        return {
          id: question.id,
          ...getQuestionTypeHandler(snapshot.type).grade(
            snapshot.answerKey,
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
      for (const { isCorrect, score, ids } of groups.values()) {
        await tx.attemptQuestion.updateMany({
          where: { id: { in: ids } },
          data: { isCorrect, score },
        });
      }

      const score = graded.reduce((sum, item) => sum + item.score, 0);
      const percent = percentOf(score, maxScore);
      await tx.attempt.update({
        where: { id: attemptId },
        data: {
          status,
          submittedAt: new Date(),
          score,
          correctCount: graded.filter((item) => item.isCorrect).length,
          passed: passingScore === null ? null : percent >= passingScore,
        },
      });
    });
  }

  private async view(attemptId: string) {
    const attempt = await this.prisma.attempt.findUniqueOrThrow({
      where: { id: attemptId },
      select: {
        ...attemptSelect,
        questions: {
          orderBy: { order: 'asc' },
          select: {
            id: true,
            order: true,
            sectionId: true,
            sectionTitle: true,
            sectionOrder: true,
            points: true,
            snapshot: true,
            response: true,
            flagged: true,
            answeredAt: true,
          },
        },
      },
    });

    const sections = new Map<
      number,
      {
        sectionId: string | null;
        title: string;
        order: number;
        questionCount: number;
      }
    >();
    for (const question of attempt.questions) {
      const section = sections.get(question.sectionOrder) ?? {
        sectionId: question.sectionId,
        title: question.sectionTitle,
        order: question.sectionOrder,
        questionCount: 0,
      };
      section.questionCount++;
      sections.set(question.sectionOrder, section);
    }

    const { userId: _userId, questions, ...rest } = attempt;
    return {
      ...rest,
      serverTime: new Date(),
      answeredCount: questions.filter((question) => question.response !== null)
        .length,
      flaggedCount: questions.filter((question) => question.flagged).length,
      sections: [...sections.values()].sort((a, b) => a.order - b.order),
      // Domain, difficulty, answer key and explanation stay hidden until the attempt is reviewed.
      questions: questions.map(({ snapshot, ...question }) => {
        const { type, content, data } = asSnapshot(snapshot);
        return { ...question, type, content, data };
      }),
    };
  }

  private async findOwned(user: AuthUser, attemptId: string) {
    const attempt = await this.prisma.attempt.findUnique({
      where: { id: attemptId },
      select: attemptSelect,
    });
    if (!attempt || attempt.userId !== user.id) {
      throw AppError.notFound('Attempt');
    }
    return attempt;
  }

  /** Result and review need a closed attempt; an overdue one is closed on the spot. */
  private async findClosed(
    user: AuthUser,
    attemptId: string,
  ): Promise<AttemptRow> {
    const attempt = await this.findOwned(user, attemptId);
    if (attempt.status !== AttemptStatus.IN_PROGRESS) return attempt;
    if (!isOverdue(attempt)) {
      throw AppError.conflict(
        'ATTEMPT_NOT_SUBMITTED',
        'Submit the attempt to see the result',
      );
    }
    await this.finalize(attempt.id, AttemptStatus.EXPIRED);
    return this.findOwned(user, attemptId);
  }

  private assertInProgress(attempt: AttemptRow) {
    if (attempt.status !== AttemptStatus.IN_PROGRESS) throw this.closedError();
  }

  private closedError() {
    return AppError.conflict(
      'ATTEMPT_CLOSED',
      'This attempt has already been submitted',
    );
  }
}
