import { Injectable } from '@nestjs/common';

import { paginated, toSkipTake } from '../../common/dto/pagination.dto.js';
import { AppError } from '../../common/errors/app-error.js';
import type { AuthUser } from '../../common/types/auth-user.js';
import { assertOwner, ownedBy } from '../../common/utils/access.js';
import { ExamStatus, type Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { getQuestionTypeHandler } from '../questions/question-types/index.js';
import type {
  CreateExamDto,
  ListExamsQueryDto,
  UpdateExamDto,
} from './dto/exams.dto.js';

const examSummarySelect = {
  id: true,
  ownerId: true,
  topicId: true,
  title: true,
  description: true,
  status: true,
  durationMinutes: true,
  passingScore: true,
  shuffleQuestions: true,
  shuffleOptions: true,
  publishedAt: true,
  createdAt: true,
  updatedAt: true,
  topic: { select: { id: true, name: true } },
  _count: { select: { sections: true, questions: true, attempts: true } },
} satisfies Prisma.ExamSelect;

const examDetailSelect = {
  ...examSummarySelect,
  sections: {
    orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      title: true,
      order: true,
      instructions: true,
      questions: {
        orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
        select: {
          questionId: true,
          order: true,
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
} satisfies Prisma.ExamSelect;

type ExamDetailRow = Prisma.ExamGetPayload<{ select: typeof examDetailSelect }>;

function toExamDetail(exam: ExamDetailRow) {
  const questions = exam.sections.flatMap((section) => section.questions);
  return {
    ...exam,
    questionCount: questions.length,
    totalPoints: questions.reduce((sum, item) => sum + item.points, 0),
  };
}

@Injectable()
export class ExamsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: AuthUser, query: ListExamsQueryDto) {
    const where: Prisma.ExamWhereInput = {
      ...ownedBy(user),
      status: query.status,
      topicId: query.topicId,
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.exam.findMany({
        where,
        select: examSummarySelect,
        orderBy: { updatedAt: 'desc' },
        ...toSkipTake(query),
      }),
      this.prisma.exam.count({ where }),
    ]);
    return paginated(items, total, query);
  }

  /** An exam always starts with at least one section, created in the same statement. */
  async create(user: AuthUser, dto: CreateExamDto) {
    const topic = await this.prisma.topic.findUnique({
      where: { id: dto.topicId },
      select: { id: true },
    });
    if (!topic) throw AppError.notFound('Topic');

    const sections = dto.sections ?? [{ title: 'Section 1' }];
    const exam = await this.prisma.exam.create({
      data: {
        ownerId: user.id,
        topicId: dto.topicId,
        title: dto.title,
        description: dto.description,
        durationMinutes: dto.durationMinutes,
        passingScore: dto.passingScore,
        shuffleQuestions: dto.shuffleQuestions,
        shuffleOptions: dto.shuffleOptions,
        sections: {
          create: sections.map((section, index) => ({
            title: section.title,
            instructions: section.instructions,
            order: index + 1,
          })),
        },
      },
      select: { id: true },
    });
    return this.detail(exam.id);
  }

  async get(user: AuthUser, id: string) {
    await this.findOwned(user, id);
    return this.detail(id);
  }

  async update(user: AuthUser, id: string, dto: UpdateExamDto) {
    await this.findEditable(user, id);
    await this.prisma.exam.update({
      where: { id },
      data: {
        title: dto.title,
        description: dto.description,
        durationMinutes: dto.durationMinutes,
        passingScore: dto.passingScore,
        shuffleQuestions: dto.shuffleQuestions,
        shuffleOptions: dto.shuffleOptions,
      },
    });
    return this.detail(id);
  }

  async remove(user: AuthUser, id: string) {
    const exam = await this.findOwned(user, id);
    if (exam._count.attempts > 0) {
      throw AppError.conflict(
        'EXAM_HAS_ATTEMPTS',
        'This exam already has attempts; archive it instead of deleting',
      );
    }
    await this.prisma.exam.delete({ where: { id } });
  }

  /** DRAFT → PUBLISHED after checking every section has questions and every question is valid. */
  async publish(user: AuthUser, id: string) {
    const exam = await this.findOwned(user, id);
    if (exam.status !== ExamStatus.DRAFT) {
      throw AppError.conflict(
        'INVALID_STATUS',
        `Only draft exams can be published (current status: ${exam.status})`,
      );
    }

    const issues = this.publishIssues(await this.detail(id));
    if (issues.length > 0) {
      const more = issues.length > 1 ? ` (+${issues.length - 1} more)` : '';
      throw AppError.conflict(
        'EXAM_NOT_PUBLISHABLE',
        `${issues[0]}${more}`,
        issues,
      );
    }

    const { count } = await this.prisma.exam.updateMany({
      where: { id, status: ExamStatus.DRAFT },
      data: { status: ExamStatus.PUBLISHED, publishedAt: new Date() },
    });
    if (count !== 1) {
      throw AppError.conflict('INVALID_STATUS', 'Exam status changed, retry');
    }
    return this.detail(id);
  }

  /** Back to DRAFT so it can be edited. Attempts already started keep their snapshot. */
  async unpublish(user: AuthUser, id: string) {
    await this.findOwned(user, id);
    await this.prisma.exam.update({
      where: { id },
      data: { status: ExamStatus.DRAFT, publishedAt: null },
    });
    return this.detail(id);
  }

  /** Hidden from the catalog; attempt history is kept. */
  async archive(user: AuthUser, id: string) {
    await this.findOwned(user, id);
    await this.prisma.exam.update({
      where: { id },
      data: { status: ExamStatus.ARCHIVED },
    });
    return this.detail(id);
  }

  async detail(id: string) {
    const exam = await this.prisma.exam.findUniqueOrThrow({
      where: { id },
      select: examDetailSelect,
    });
    return toExamDetail(exam);
  }

  async findOwned(user: AuthUser, id: string) {
    const exam = await this.prisma.exam.findUnique({
      where: { id },
      select: examSummarySelect,
    });
    return assertOwner(exam, user, 'Exam');
  }

  /** Exam structure and settings can only change while the exam is a draft. */
  async findEditable(user: AuthUser, id: string) {
    const exam = await this.findOwned(user, id);
    if (exam.status !== ExamStatus.DRAFT) {
      throw AppError.conflict(
        'EXAM_NOT_EDITABLE',
        'Only draft exams can be edited; unpublish it first',
      );
    }
    return exam;
  }

  private publishIssues(exam: ReturnType<typeof toExamDetail>): string[] {
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
}
