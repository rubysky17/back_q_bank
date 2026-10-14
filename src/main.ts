import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';
import { API_PREFIX, configureApp } from './app.setup.js';
import type { Env } from './config/env.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  app.enableShutdownHooks();

  const config = app.get<ConfigService<Env, true>>(ConfigService);
  const port = config.get('PORT', { infer: true });
  await app.listen(port, config.get('HOST', { infer: true }));

  const base = `http://localhost:${port}/${API_PREFIX}`;
  const docs = config.get('SWAGGER_ENABLED', { infer: true })
    ? ` (docs: ${base}/docs)`
    : '';
  Logger.log(`API ready at ${base}${docs}`, 'Bootstrap');
}
await bootstrap();
