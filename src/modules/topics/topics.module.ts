import { Module } from '@nestjs/common';

import { DomainsController, TopicsController } from './topics.controller.js';
import { TopicsService } from './topics.service.js';

@Module({
  controllers: [TopicsController, DomainsController],
  providers: [TopicsService],
})
export class TopicsModule {}
