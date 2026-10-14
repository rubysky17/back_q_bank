import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsObject,
  IsOptional,
  IsUUID,
  ValidateNested,
} from 'class-validator';

import { PaginationQueryDto } from '../../../common/dto/pagination.dto.js';
import { AttemptStatus } from '../../../generated/prisma/client.js';

export class AnswerDto {
  @IsUUID()
  attemptQuestionId: string;

  @ApiPropertyOptional({
    type: 'object',
    nullable: true,
    additionalProperties: true,
    description:
      'Type-specific answer. SINGLE_CHOICE: { "optionId": "..." }. null clears the answer; omit to keep it.',
    example: { optionId: '7c0e8c1e-2f7a-4b55-9c55-1a2b3c4d5e6f' },
  })
  @IsOptional()
  @IsObject()
  response?: Record<string, unknown> | null;

  /** "Mark for review". Omit to keep the current flag. */
  @IsOptional()
  @IsBoolean()
  flagged?: boolean;
}

/** Saves several answers at once (the app can batch while offline or between questions). */
export class SaveAnswersDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => AnswerDto)
  answers: AnswerDto[];
}

export class ListAttemptsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  examId?: string;

  @IsOptional()
  @IsEnum(AttemptStatus)
  status?: AttemptStatus;
}
