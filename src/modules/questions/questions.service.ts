import { Injectable } from '@nestjs/common';

import { paginated, toSkipTake } from '../../common/dto/pagination.dto.js';
import { AppError } from '../../common/errors/app-error.js';
import type { AuthUser } from '../../common/types/auth-user.js';
import { assertOwner, ownedBy } from '../../common/utils/access.js';
import { type Prisma, QuestionType } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type {
  CreateQuestionDto,
  ListQuestionsQueryDto,
  UpdateQuestionDto,
} from './dto/questions.dto.js';
import { getQuestionTypeHandler } from './question-types/index.js';

export const questionSelect = {
  id: true,
  ownerId: true,
  topicId: true,
  domainId: true,
  type: true,
  difficulty: true,
  content: true,
  explanation: true,
  definition: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  topic: { select: { id: true, name: true } },
  domain: { select: { id: true, name: true } },
  _count: { select: { examQuestions: true } },
} satisfies Prisma.QuestionSelect;

@Injectable()
export class QuestionsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: AuthUser, query: ListQuestionsQueryDto) {
    const where: Prisma.QuestionWhereInput = {
      ...ownedBy(user),
      topicId: query.topicId,
      domainId: query.domainId,
      difficulty: query.difficulty,
      type: query.type,
      ...(query.q
        ? { content: { contains: query.q, mode: 'insensitive' } }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.question.findMany({
        where,
        select: questionSelect,
        orderBy: { createdAt: 'desc' },
        ...toSkipTake(query),
      }),
      this.prisma.question.count({ where }),
    ]);
    return paginated(items, total, query);
  }

  async get(user: AuthUser, id: string) {
    const question = await this.prisma.question.findUnique({
      where: { id },
      select: questionSelect,
    });
    return assertOwner(question, user, 'Question');
  }

  async create(user: AuthUser, dto: CreateQuestionDto) {
    const type = dto.type ?? QuestionType.SINGLE_CHOICE;
    const definition = getQuestionTypeHandler(type).parseDefinition(
      dto.definition,
    );
    await this.assertTopicAndDomain(dto.topicId, dto.domainId ?? null);

    return this.prisma.question.create({
      data: {
        ownerId: user.id,
        topicId: dto.topicId,
        domainId: dto.domainId ?? null,
        type,
        difficulty: dto.difficulty,
        content: dto.content,
        explanation: dto.explanation,
        definition: definition as Prisma.InputJsonValue,
      },
      select: questionSelect,
    });
  }

  /** Every edit bumps `version`; attempts already started keep their own snapshot. */
  async update(user: AuthUser, id: string, dto: UpdateQuestionDto) {
    const current = await this.get(user, id);

    const topicId = dto.topicId ?? current.topicId;
    if (topicId !== current.topicId && current._count.examQuestions > 0) {
      throw AppError.conflict(
        'QUESTION_IN_USE',
        'A question used in exams cannot move to another topic',
      );
    }
    const domainId =
      dto.domainId === undefined ? current.domainId : dto.domainId;
    await this.assertTopicAndDomain(topicId, domainId);

    const type = dto.type ?? current.type;
    if (type !== current.type && dto.definition === undefined) {
      throw AppError.badRequest(
        'DEFINITION_REQUIRED',
        'Changing the question type requires a new definition',
      );
    }
    const definition =
      dto.definition === undefined
        ? undefined
        : (getQuestionTypeHandler(type).parseDefinition(
            dto.definition,
          ) as Prisma.InputJsonValue);

    return this.prisma.question.update({
      where: { id },
      data: {
        topicId,
        domainId,
        type,
        difficulty: dto.difficulty,
        content: dto.content,
        explanation: dto.explanation,
        definition,
        version: { increment: 1 },
      },
      select: questionSelect,
    });
  }

  /** Fails with 409 QUESTION_IN_USE while any exam contains the question. */
  async remove(user: AuthUser, id: string) {
    const question = await this.get(user, id);
    if (question._count.examQuestions > 0) {
      throw AppError.conflict(
        'QUESTION_IN_USE',
        `Question is used in ${question._count.examQuestions} exam(s); remove it from those exams first`,
      );
    }
    await this.prisma.question.delete({ where: { id } });
  }

  private async assertTopicAndDomain(topicId: string, domainId: string | null) {
    const topic = await this.prisma.topic.findUnique({
      where: { id: topicId },
      select: { id: true },
    });
    if (!topic) throw AppError.notFound('Topic');
    if (!domainId) return;

    const domain = await this.prisma.domain.findUnique({
      where: { id: domainId },
      select: { topicId: true },
    });
    if (!domain) throw AppError.notFound('Domain');
    if (domain.topicId !== topicId) {
      throw AppError.badRequest(
        'DOMAIN_TOPIC_MISMATCH',
        'The domain does not belong to the question topic',
      );
    }
  }
}
