import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../../common/decorators/auth.decorators.js';
import type { AuthUser } from '../../common/types/auth-user.js';
import { AttemptsService } from '../attempts/attempts.service.js';
import { CatalogService } from './catalog.service.js';
import { CatalogQueryDto } from './dto/catalog.dto.js';

@ApiTags('catalog')
@ApiBearerAuth()
@Controller('catalog/exams')
export class CatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly attempts: AttemptsService,
  ) {}

  @Get()
  list(@Query() query: CatalogQueryDto) {
    return this.catalog.list(query);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.catalog.get(user, id);
  }

  /** Starts an attempt, or returns the one in progress (`resumed: true`). */
  @Post(':id/attempts')
  start(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.attempts.start(user, id);
  }
}
