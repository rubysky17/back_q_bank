import { ApiProperty, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

import { PaginationQueryDto } from '../../../common/dto/pagination.dto.js';
import { Difficulty, QuestionType } from '../../../generated/prisma/client.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateQuestionDto {
  @IsUUID()
  topicId: string;

  /** Must belong to `topicId`. Send null to clear it on update. */
  @IsOptional()
  @IsUUID()
  domainId?: string | null;

  /** Defaults to SINGLE_CHOICE (the only supported type for now). */
  @IsOptional()
  @IsEnum(QuestionType)
  type?: QuestionType;

  /** Defaults to MEDIUM. */
  @IsOptional()
  @IsEnum(Difficulty)
  difficulty?: Difficulty;

  /** The question stem (plain text or markdown). */
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(10_000)
  content: string;

  /** Shown to the test taker after submitting. */
  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  explanation?: string | null;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'Type-specific payload. SINGLE_CHOICE: 2-10 options, exactly one with isCorrect=true. ' +
      'Omit option ids for new options; keep them when editing.',
    example: {
      options: [
        { content: 'Escalate to the sponsor', isCorrect: false },
        { content: 'Meet both team members to resolve it', isCorrect: true },
        { content: 'Reassign one of them', isCorrect: false },
      ],
    },
  })
  @IsObject()
  definition: Record<string, unknown>;
}

export class UpdateQuestionDto extends PartialType(CreateQuestionDto) {}

export class ListQuestionsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  topicId?: string;

  @IsOptional()
  @IsUUID()
  domainId?: string;

  @IsOptional()
  @IsEnum(Difficulty)
  difficulty?: Difficulty;

  @IsOptional()
  @IsEnum(QuestionType)
  type?: QuestionType;

  /** Searches the question content. */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  q?: string;
}
