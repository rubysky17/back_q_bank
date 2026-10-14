import { Injectable } from '@nestjs/common';

import { paginated, toSkipTake } from '../../common/dto/pagination.dto.js';
import { AppError } from '../../common/errors/app-error.js';
import type { AuthUser } from '../../common/types/auth-user.js';
import { ExamStatus, type Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AttemptsService } from '../attempts/attempts.service.js';
import type { CatalogQueryDto } from './dto/catalog.dto.js';

const catalogExamSelect = {
  id: true,
  title: true,
  description: true,
  durationMinutes: true,
  passingScore: true,
  publishedAt: true,
  topic: { select: { id: true, name: true } },
  owner: { select: { id: true, fullName: true } },
  _count: { select: { questions: true, sections: true } },
} satisfies Prisma.ExamSelect;

type CatalogExamRow = Prisma.ExamGetPayload<{
  select: typeof catalogExamSelect;
}>;

function toCatalogExam({ _count, ...exam }: CatalogExamRow) {
  return {
    ...exam,
    questionCount: _count.questions,
    sectionCount: _count.sections,
  };
}

/** Published exams, visible to every signed-in user. Never exposes question content. */
@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly attempts: AttemptsService,
  ) {}

  async list(query: CatalogQueryDto) {
    const where: Prisma.ExamWhereInput = {
      status: ExamStatus.PUBLISHED,
      topicId: query.topicId,
      ...(query.q ? { title: { contains: query.q, mode: 'insensitive' } } : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.exam.findMany({
        where,
        select: catalogExamSelect,
        orderBy: { publishedAt: 'desc' },
        ...toSkipTake(query),
      }),
      this.prisma.exam.count({ where }),
    ]);
    return paginated(rows.map(toCatalogExam), total, query);
  }

  /** Exam overview before starting, plus the user's in-progress attempt (to offer "resume"). */
  async get(user: AuthUser, examId: string) {
    const exam = await this.prisma.exam.findFirst({
      where: { id: examId, status: ExamStatus.PUBLISHED },
      select: {
        ...catalogExamSelect,
        sections: {
          orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
          select: {
            id: true,
            title: true,
            order: true,
            instructions: true,
            _count: { select: { questions: true } },
          },
        },
      },
    });
    if (!exam) throw AppError.notFound('Exam');

    const [points, attemptCount, inProgress] = await Promise.all([
      this.prisma.examQuestion.aggregate({
        where: { examId },
        _sum: { points: true },
      }),
      this.prisma.attempt.count({ where: { examId, userId: user.id } }),
      this.attempts.findInProgress(user.id, examId),
    ]);

    const { sections, ...summary } = exam;
    return {
      ...toCatalogExam(summary),
      totalPoints: points._sum.points ?? 0,
      sections: sections.map(({ _count, ...section }) => ({
        ...section,
        questionCount: _count.questions,
      })),
      myAttemptCount: attemptCount,
      inProgressAttemptId: inProgress?.id ?? null,
    };
  }
}
