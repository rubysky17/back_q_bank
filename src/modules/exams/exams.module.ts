import { Module } from '@nestjs/common';

import { ExamStructureService } from './exam-structure.service.js';
import { ExamsController } from './exams.controller.js';
import { ExamsService } from './exams.service.js';

@Module({
  controllers: [ExamsController],
  providers: [ExamsService, ExamStructureService],
})
export class ExamsModule {}
