import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { CurrentUser, Roles } from '../../common/decorators/auth.decorators.js';
import type { AuthUser } from '../../common/types/auth-user.js';
import { Role } from '../../generated/prisma/client.js';
import {
  CreateDomainDto,
  CreateTopicDto,
  UpdateDomainDto,
  UpdateTopicDto,
} from './dto/topics.dto.js';
import { TopicsService } from './topics.service.js';

@ApiTags('topics')
@ApiBearerAuth()
@Controller('topics')
export class TopicsController {
  constructor(private readonly topics: TopicsService) {}

  /** All topics with their domains (any signed-in user). */
  @Get()
  list() {
    return this.topics.list();
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.topics.get(id);
  }

  @Roles(Role.HOST, Role.ADMIN)
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateTopicDto) {
    return this.topics.create(user, dto);
  }

  @Roles(Role.HOST, Role.ADMIN)
  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTopicDto,
  ) {
    return this.topics.update(user, id, dto);
  }

  /** Fails with 409 TOPIC_IN_USE while questions or exams use the topic. */
  @Roles(Role.HOST, Role.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id')
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.topics.remove(user, id);
  }

  @Roles(Role.HOST, Role.ADMIN)
  @Post(':topicId/domains')
  createDomain(
    @CurrentUser() user: AuthUser,
    @Param('topicId', ParseUUIDPipe) topicId: string,
    @Body() dto: CreateDomainDto,
  ) {
    return this.topics.createDomain(user, topicId, dto);
  }
}

@ApiTags('topics')
@ApiBearerAuth()
@Roles(Role.HOST, Role.ADMIN)
@Controller('domains')
export class DomainsController {
  constructor(private readonly topics: TopicsService) {}

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDomainDto,
  ) {
    return this.topics.updateDomain(user, id, dto);
  }

  /** Fails with 409 DOMAIN_IN_USE while questions are tagged with it. */
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id')
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.topics.removeDomain(user, id);
  }
}
