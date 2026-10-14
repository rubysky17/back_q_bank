import { Injectable } from '@nestjs/common';

import { AppError } from '../../common/errors/app-error.js';
import type { AuthUser } from '../../common/types/auth-user.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type {
  AddExamQuestionsDto,
  CreateSectionDto,
  ReorderQuestionsDto,
  ReorderSectionsDto,
  UpdateExamQuestionDto,
  UpdateSectionDto,
} from './dto/exams.dto.js';
import { ExamsService } from './exams.service.js';

function sameIds(expected: string[], actual: string[]) {
  return (
    expected.length === actual.length &&
    new Set([...expected, ...actual]).size === expected.length
  );
}

/** Sections and the questions placed in them. Every change requires a DRAFT exam. */
@Injectable()
export class ExamStructureService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly exams: ExamsService,
  ) {}

  async addSection(user: AuthUser, examId: string, dto: CreateSectionDto) {
    await this.exams.findEditable(user, examId);
    const { _max } = await this.prisma.examSection.aggregate({
      where: { examId },
      _max: { order: true },
    });
    await this.prisma.examSection.create({
      data: {
        examId,
        title: dto.title,
        instructions: dto.instructions,
        order: (_max.order ?? 0) + 1,
      },
    });
    return this.exams.detail(examId);
  }

  async updateSection(
    user: AuthUser,
    examId: string,
    sectionId: string,
    dto: UpdateSectionDto,
  ) {
    await this.exams.findEditable(user, examId);
    await this.findSection(examId, sectionId);
    await this.prisma.examSection.update({
      where: { id: sectionId },
      data: { title: dto.title, instructions: dto.instructions },
    });
    return this.exams.detail(examId);
  }

  /** Removes the section and takes its questions out of the exam (they stay in the bank). */
  async removeSection(user: AuthUser, examId: string, sectionId: string) {
    const exam = await this.exams.findEditable(user, examId);
    await this.findSection(examId, sectionId);
    if (exam._count.sections <= 1) {
      throw AppError.conflict(
        'LAST_SECTION',
        'An exam needs at least one section',
      );
    }
    await this.prisma.examSection.delete({ where: { id: sectionId } });
    return this.exams.detail(examId);
  }

  async reorderSections(
    user: AuthUser,
    examId: string,
    dto: ReorderSectionsDto,
  ) {
    await this.exams.findEditable(user, examId);
    const sections = await this.prisma.examSection.findMany({
      where: { examId },
      select: { id: true },
    });
    if (
      !sameIds(
        sections.map((section) => section.id),
        dto.sectionIds,
      )
    ) {
      throw AppError.badRequest(
        'INVALID_ORDER',
        'sectionIds must list every section of the exam exactly once',
      );
    }
    await this.prisma.$transaction(
      dto.sectionIds.map((id, index) =>
        this.prisma.examSection.update({
          where: { id },
          data: { order: index + 1 },
        }),
      ),
    );
    return this.exams.detail(examId);
  }

  /**
   * Appends questions to a section. They must come from the exam owner's bank and the exam's topic,
   * otherwise a host could read another host's answers through the review screen.
   */
  async addQuestions(
    user: AuthUser,
    examId: string,
    sectionId: string,
    dto: AddExamQuestionsDto,
  ) {
    const exam = await this.exams.findEditable(user, examId);
    await this.findSection(examId, sectionId);

    const found = await this.prisma.question.findMany({
      where: { id: { in: dto.questionIds } },
      select: { id: true, ownerId: true, topicId: true },
    });
    const usable = new Map(
      found
        .filter((question) => question.ownerId === exam.ownerId)
        .map((question) => [question.id, question]),
    );
    const missing = dto.questionIds.filter((id) => !usable.has(id));
    if (missing.length > 0) {
      throw AppError.badRequest(
        'QUESTIONS_NOT_FOUND',
        `${missing.length} question(s) were not found in the exam owner's bank`,
        { questionIds: missing },
      );
    }
    const otherTopic = dto.questionIds.filter(
      (id) => usable.get(id)?.topicId !== exam.topicId,
    );
    if (otherTopic.length > 0) {
      throw AppError.badRequest(
        'QUESTION_TOPIC_MISMATCH',
        `${otherTopic.length} question(s) belong to a different topic than the exam`,
        { questionIds: otherTopic },
      );
    }

    const already = await this.prisma.examQuestion.findMany({
      where: { examId, questionId: { in: dto.questionIds } },
      select: { questionId: true },
    });
    if (already.length > 0) {
      throw AppError.conflict(
        'QUESTION_ALREADY_IN_EXAM',
        `${already.length} question(s) are already in this exam`,
        { questionIds: already.map((item) => item.questionId) },
      );
    }

    const start = await this.nextQuestionOrder(sectionId);
    await this.prisma.examQuestion.createMany({
      data: dto.questionIds.map((questionId, index) => ({
        examId,
        sectionId,
        questionId,
        order: start + index,
        points: dto.points ?? 1,
      })),
    });
    return this.exams.detail(examId);
  }

  async updateQuestion(
    user: AuthUser,
    examId: string,
    questionId: string,
    dto: UpdateExamQuestionDto,
  ) {
    await this.exams.findEditable(user, examId);
    const item = await this.findExamQuestion(examId, questionId);

    let move: { sectionId: string; order: number } | undefined;
    if (dto.sectionId && dto.sectionId !== item.sectionId) {
      await this.findSection(examId, dto.sectionId);
      move = {
        sectionId: dto.sectionId,
        order: await this.nextQuestionOrder(dto.sectionId),
      };
    }
    await this.prisma.examQuestion.update({
      where: { id: item.id },
      data: { points: dto.points, ...move },
    });
    return this.exams.detail(examId);
  }

  /** Takes the question out of the exam; it stays in the question bank. */
  async removeQuestion(user: AuthUser, examId: string, questionId: string) {
    await this.exams.findEditable(user, examId);
    const item = await this.findExamQuestion(examId, questionId);
    await this.prisma.examQuestion.delete({ where: { id: item.id } });
    return this.exams.detail(examId);
  }

  async reorderQuestions(
    user: AuthUser,
    examId: string,
    sectionId: string,
    dto: ReorderQuestionsDto,
  ) {
    await this.exams.findEditable(user, examId);
    await this.findSection(examId, sectionId);
    const items = await this.prisma.examQuestion.findMany({
      where: { sectionId },
      select: { id: true, questionId: true },
    });
    if (
      !sameIds(
        items.map((item) => item.questionId),
        dto.questionIds,
      )
    ) {
      throw AppError.badRequest(
        'INVALID_ORDER',
        'questionIds must list every question of the section exactly once',
      );
    }
    const idByQuestion = new Map(
      items.map((item) => [item.questionId, item.id]),
    );
    await this.prisma.$transaction(
      dto.questionIds.map((questionId, index) =>
        this.prisma.examQuestion.update({
          where: { id: idByQuestion.get(questionId) },
          data: { order: index + 1 },
        }),
      ),
    );
    return this.exams.detail(examId);
  }

  private async findSection(examId: string, sectionId: string) {
    const section = await this.prisma.examSection.findFirst({
      where: { id: sectionId, examId },
      select: { id: true },
    });
    if (!section) throw AppError.notFound('Section');
    return section;
  }

  private async findExamQuestion(examId: string, questionId: string) {
    const item = await this.prisma.examQuestion.findUnique({
      where: { examId_questionId: { examId, questionId } },
      select: { id: true, sectionId: true },
    });
    if (!item) throw AppError.notFound('Question in this exam');
    return item;
  }

  private async nextQuestionOrder(sectionId: string) {
    const { _max } = await this.prisma.examQuestion.aggregate({
      where: { sectionId },
      _max: { order: true },
    });
    return (_max.order ?? 0) + 1;
  }
}
