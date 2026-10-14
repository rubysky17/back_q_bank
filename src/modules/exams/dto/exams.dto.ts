import { OmitType, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { PaginationQueryDto } from '../../../common/dto/pagination.dto.js';
import { ExamStatus } from '../../../generated/prisma/client.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class SectionInputDto {
  /** e.g. "Section 1" */
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  instructions?: string | null;
}

export class CreateExamDto {
  @IsUUID()
  topicId: string;

  /** e.g. "PMP Mock Test 1" */
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string | null;

  /** Total time in minutes; null or omitted = untimed. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1440)
  durationMinutes?: number | null;

  /** Pass mark in percent; null or omitted = no pass/fail. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  passingScore?: number | null;

  /** Shuffle question order inside each section for every attempt. */
  @IsOptional()
  @IsBoolean()
  shuffleQuestions?: boolean;

  /** Shuffle answer options for every attempt. */
  @IsOptional()
  @IsBoolean()
  shuffleOptions?: boolean;

  /** Initial sections. Omit for an exam without sections (a single default section is created). */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => SectionInputDto)
  sections?: SectionInputDto[];
}

export class UpdateExamDto extends PartialType(
  OmitType(CreateExamDto, ['topicId', 'sections'] as const),
) {}

export class ListExamsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(ExamStatus)
  status?: ExamStatus;

  @IsOptional()
  @IsUUID()
  topicId?: string;
}

export class CreateSectionDto extends SectionInputDto {}

export class UpdateSectionDto extends PartialType(SectionInputDto) {}

export class ReorderSectionsDto {
  /** Every section id of the exam, in the new order. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  sectionIds: string[];
}

export class AddExamQuestionsDto {
  /** Questions from the exam owner's bank, same topic as the exam. Appended in this order. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  questionIds: string[];

  /** Points per question (default 1). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  points?: number;
}

export class UpdateExamQuestionDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  points?: number;

  /** Moves the question to the end of another section of the same exam. */
  @IsOptional()
  @IsUUID()
  sectionId?: string;
}

export class ReorderQuestionsDto {
  /** Every question id of the section, in the new order. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  questionIds: string[];
}
