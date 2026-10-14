import { Transform } from 'class-transformer';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

import { PaginationQueryDto } from '../../../common/dto/pagination.dto.js';

export class CatalogQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  topicId?: string;

  /** Searches the exam title. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(200)
  q?: string;
}
