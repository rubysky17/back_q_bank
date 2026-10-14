import { Injectable } from '@nestjs/common';

import { AppError } from '../../common/errors/app-error.js';
import type { AuthUser } from '../../common/types/auth-user.js';
import { isAdmin } from '../../common/utils/access.js';
import { slugify } from '../../common/utils/slugify.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type {
  CreateDomainDto,
  CreateTopicDto,
  UpdateDomainDto,
  UpdateTopicDto,
} from './dto/topics.dto.js';

const domainSelect = {
  id: true,
  topicId: true,
  name: true,
  description: true,
  order: true,
  createdById: true,
} satisfies Prisma.DomainSelect;

const topicSelect = {
  id: true,
  name: true,
  slug: true,
  description: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
  domains: {
    select: domainSelect,
    orderBy: [{ order: 'asc' }, { name: 'asc' }],
  },
} satisfies Prisma.TopicSelect;

/** Topics and domains are shared by all hosts; only their creator or an admin may change them. */
function assertCreator(createdById: string, user: AuthUser) {
  if (!isAdmin(user) && createdById !== user.id) {
    throw AppError.forbidden('Only the creator or an admin can change this');
  }
}

@Injectable()
export class TopicsService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.topic.findMany({
      select: topicSelect,
      orderBy: { name: 'asc' },
    });
  }

  async get(id: string) {
    const topic = await this.prisma.topic.findUnique({
      where: { id },
      select: topicSelect,
    });
    if (!topic) throw AppError.notFound('Topic');
    return topic;
  }

  async create(user: AuthUser, dto: CreateTopicDto) {
    const slug = await this.uniqueSlug(dto.name);
    return this.prisma.topic.create({
      data: {
        name: dto.name,
        slug,
        description: dto.description,
        createdById: user.id,
      },
      select: topicSelect,
    });
  }

  async update(user: AuthUser, id: string, dto: UpdateTopicDto) {
    const topic = await this.get(id);
    assertCreator(topic.createdById, user);
    const slug =
      dto.name !== undefined ? await this.uniqueSlug(dto.name, id) : undefined;
    return this.prisma.topic.update({
      where: { id },
      data: { name: dto.name, slug, description: dto.description },
      select: topicSelect,
    });
  }

  async remove(user: AuthUser, id: string) {
    const topic = await this.get(id);
    assertCreator(topic.createdById, user);
    const [questions, exams] = await Promise.all([
      this.prisma.question.count({ where: { topicId: id } }),
      this.prisma.exam.count({ where: { topicId: id } }),
    ]);
    if (questions > 0 || exams > 0) {
      throw AppError.conflict(
        'TOPIC_IN_USE',
        `Topic is used by ${questions} question(s) and ${exams} exam(s)`,
        { questions, exams },
      );
    }
    await this.prisma.topic.delete({ where: { id } });
  }

  async createDomain(user: AuthUser, topicId: string, dto: CreateDomainDto) {
    await this.get(topicId);
    await this.assertDomainNameFree(topicId, dto.name);
    const order =
      dto.order ?? (await this.prisma.domain.count({ where: { topicId } }));
    return this.prisma.domain.create({
      data: {
        topicId,
        name: dto.name,
        description: dto.description,
        order,
        createdById: user.id,
      },
      select: domainSelect,
    });
  }

  async updateDomain(user: AuthUser, id: string, dto: UpdateDomainDto) {
    const domain = await this.getDomain(id);
    assertCreator(domain.createdById, user);
    if (dto.name !== undefined) {
      await this.assertDomainNameFree(domain.topicId, dto.name, id);
    }
    return this.prisma.domain.update({
      where: { id },
      data: { name: dto.name, description: dto.description, order: dto.order },
      select: domainSelect,
    });
  }

  async removeDomain(user: AuthUser, id: string) {
    const domain = await this.getDomain(id);
    assertCreator(domain.createdById, user);
    const questions = await this.prisma.question.count({
      where: { domainId: id },
    });
    if (questions > 0) {
      throw AppError.conflict(
        'DOMAIN_IN_USE',
        `Domain is used by ${questions} question(s)`,
        { questions },
      );
    }
    await this.prisma.domain.delete({ where: { id } });
  }

  private async getDomain(id: string) {
    const domain = await this.prisma.domain.findUnique({
      where: { id },
      select: domainSelect,
    });
    if (!domain) throw AppError.notFound('Domain');
    return domain;
  }

  private async uniqueSlug(name: string, exceptId?: string) {
    const slug = slugify(name);
    if (!slug) {
      throw AppError.badRequest(
        'INVALID_NAME',
        'Name must contain letters or digits',
      );
    }
    const clash = await this.prisma.topic.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (clash && clash.id !== exceptId) {
      throw AppError.conflict(
        'TOPIC_EXISTS',
        `Topic "${name}" already exists`,
        {
          topicId: clash.id,
        },
      );
    }
    return slug;
  }

  private async assertDomainNameFree(
    topicId: string,
    name: string,
    exceptId?: string,
  ) {
    const clash = await this.prisma.domain.findFirst({
      where: {
        topicId,
        name: { equals: name, mode: 'insensitive' },
        ...(exceptId ? { NOT: { id: exceptId } } : {}),
      },
      select: { id: true },
    });
    if (clash) {
      throw AppError.conflict(
        'DOMAIN_EXISTS',
        `Domain "${name}" already exists in this topic`,
        { domainId: clash.id },
      );
    }
  }
}
