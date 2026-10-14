import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

import { PaginationQueryDto } from '../../../common/dto/pagination.dto.js';
import { Role } from '../../../generated/prisma/client.js';

export class ListUsersQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  /** Matches email or full name. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(100)
  q?: string;
}

/** Only USER <-> HOST can be changed through the API; ADMIN accounts come from the seed. */
export class UpdateUserRoleDto {
  @IsIn([Role.USER, Role.HOST])
  role: typeof Role.USER | typeof Role.HOST;
}

export class UpdateUserStatusDto {
  @IsBoolean()
  isActive: boolean;
}
