import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../../common/decorators/auth.decorators.js';
import type { AuthUser } from '../../common/types/auth-user.js';
import { AttemptsService } from './attempts.service.js';
import { ListAttemptsQueryDto, SaveAnswersDto } from './dto/attempts.dto.js';

/** The signed-in user's own attempts. Start one with POST /catalog/exams/:id/attempts. */
@ApiTags('attempts')
@ApiBearerAuth()
@Controller('attempts')
export class AttemptsController {
  constructor(private readonly attempts: AttemptsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: ListAttemptsQueryDto) {
    return this.attempts.list(user, query);
  }

  /** Questions (without answers), saved responses, `expiresAt` and `serverTime` for the timer. */
  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.attempts.get(user, id);
  }

  @Patch(':id/answers')
  saveAnswers(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SaveAnswersDto,
  ) {
    return this.attempts.saveAnswers(user, id, dto);
  }

  /** Grades the attempt and returns the result. Safe to retry. */
  @HttpCode(HttpStatus.OK)
  @Post(':id/submit')
  submit(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.attempts.submit(user, id);
  }

  /** Score, pass/fail and breakdown by section, domain and difficulty. */
  @Get(':id/result')
  result(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.attempts.result(user, id);
  }

  /** Every question with the user's answer, the correct answer and the explanation. */
  @Get(':id/review')
  review(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.attempts.review(user, id);
  }
}
