import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';

import { type Env, validateEnv } from './config/env.js';
import { HealthController } from './health/health.controller.js';
import { AdminModule } from './modules/admin/admin.module.js';
import { AttemptsModule } from './modules/attempts/attempts.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { CatalogModule } from './modules/catalog/catalog.module.js';
import { ExamsModule } from './modules/exams/exams.module.js';
import { QuestionsModule } from './modules/questions/questions.module.js';
import { TopicsModule } from './modules/topics/topics.module.js';
import { PrismaModule } from './prisma/prisma.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: process.env.NODE_ENV === 'test' ? '.env.test' : '.env',
      validate: validateEnv,
    }),
    // Applied only where ThrottlerGuard is used (auth endpoints).
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => [
        {
          ttl: 60_000,
          limit: config.get('AUTH_RATE_LIMIT_PER_MINUTE', { infer: true }),
        },
      ],
    }),
    PrismaModule,
    AuthModule,
    AdminModule,
    TopicsModule,
    QuestionsModule,
    ExamsModule,
    AttemptsModule,
    CatalogModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
