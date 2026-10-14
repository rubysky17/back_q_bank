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
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { CurrentUser, Roles } from '../../common/decorators/auth.decorators.js';
import type { AuthUser } from '../../common/types/auth-user.js';
import { Role } from '../../generated/prisma/client.js';
import {
  AddExamQuestionsDto,
  CreateExamDto,
  CreateSectionDto,
  ListExamsQueryDto,
  ReorderQuestionsDto,
  ReorderSectionsDto,
  UpdateExamDto,
  UpdateExamQuestionDto,
  UpdateSectionDto,
} from './dto/exams.dto.js';
import { ExamStructureService } from './exam-structure.service.js';
import { ExamsService } from './exams.service.js';

/**
 * Exam authoring for hosts (admins can manage every exam).
 * Structure endpoints return the full exam so the editor can re-render from one response.
 */
@ApiTags('exams')
@ApiBearerAuth()
@Roles(Role.HOST, Role.ADMIN)
@Controller('exams')
export class ExamsController {
  constructor(
    private readonly exams: ExamsService,
    private readonly structure: ExamStructureService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: ListExamsQueryDto) {
    return this.exams.list(user, query);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateExamDto) {
    return this.exams.create(user, dto);
  }

  /** Full exam including sections, questions and correct answers. */
  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.exams.get(user, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateExamDto,
  ) {
    return this.exams.update(user, id, dto);
  }

  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id')
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.exams.remove(user, id);
  }

  @HttpCode(HttpStatus.OK)
  @Post(':id/publish')
  publish(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.exams.publish(user, id);
  }

  @HttpCode(HttpStatus.OK)
  @Post(':id/unpublish')
  unpublish(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.exams.unpublish(user, id);
  }

  @HttpCode(HttpStatus.OK)
  @Post(':id/archive')
  archive(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.exams.archive(user, id);
  }

  @Post(':id/sections')
  addSection(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateSectionDto,
  ) {
    return this.structure.addSection(user, id, dto);
  }

  @Put(':id/sections/order')
  reorderSections(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReorderSectionsDto,
  ) {
    return this.structure.reorderSections(user, id, dto);
  }

  @Patch(':id/sections/:sectionId')
  updateSection(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sectionId', ParseUUIDPipe) sectionId: string,
    @Body() dto: UpdateSectionDto,
  ) {
    return this.structure.updateSection(user, id, sectionId, dto);
  }

  @Delete(':id/sections/:sectionId')
  removeSection(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sectionId', ParseUUIDPipe) sectionId: string,
  ) {
    return this.structure.removeSection(user, id, sectionId);
  }

  @Post(':id/sections/:sectionId/questions')
  addQuestions(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sectionId', ParseUUIDPipe) sectionId: string,
    @Body() dto: AddExamQuestionsDto,
  ) {
    return this.structure.addQuestions(user, id, sectionId, dto);
  }

  @Put(':id/sections/:sectionId/questions/order')
  reorderQuestions(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sectionId', ParseUUIDPipe) sectionId: string,
    @Body() dto: ReorderQuestionsDto,
  ) {
    return this.structure.reorderQuestions(user, id, sectionId, dto);
  }

  @Patch(':id/questions/:questionId')
  updateQuestion(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('questionId', ParseUUIDPipe) questionId: string,
    @Body() dto: UpdateExamQuestionDto,
  ) {
    return this.structure.updateQuestion(user, id, questionId, dto);
  }

  @Delete(':id/questions/:questionId')
  removeQuestion(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('questionId', ParseUUIDPipe) questionId: string,
  ) {
    return this.structure.removeQuestion(user, id, questionId);
  }
}
