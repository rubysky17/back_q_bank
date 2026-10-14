import { Module } from '@nestjs/common';

import { AttemptsModule } from '../attempts/attempts.module.js';
import { CatalogController } from './catalog.controller.js';
import { CatalogService } from './catalog.service.js';

@Module({
  imports: [AttemptsModule],
  controllers: [CatalogController],
  providers: [CatalogService],
})
export class CatalogModule {}
