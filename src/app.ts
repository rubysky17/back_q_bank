import { sql } from 'drizzle-orm';
import { Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import { authRoutes } from './auth/routes';
import { getDb } from './db/client';
import { isForeignKeyViolation, isUniqueViolation } from './db/errors';
import { type AppEnv, type Config, loadConfig } from './env';
import { AppError, type ErrorBody } from './lib/app-error';
import { attemptRoutes } from './modules/attempts/routes';
import { catalogRoutes } from './modules/catalog/routes';
import { examRoutes } from './modules/exams/routes';
import { questionBankRoutes } from './modules/question-bank/routes';
import { questionRoutes } from './modules/questions/routes';
import { domainRoutes, topicRoutes } from './modules/topics/routes';

export const API_PREFIX = '/api/v1';

const DEFAULT_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'TOO_MANY_REQUESTS',
};

/** Normalises every error into `{ statusCode, code, message, details? }`. */
export function toErrorBody(error: unknown): ErrorBody {
  if (error instanceof AppError) return error.toBody();

  if (error instanceof HTTPException) {
    const statusCode = error.status;
    return {
      statusCode,
      code: DEFAULT_CODES[statusCode] ?? 'HTTP_ERROR',
      message: error.message || 'Request failed',
    };
  }

  if (isUniqueViolation(error)) {
    return {
      statusCode: 409,
      code: 'ALREADY_EXISTS',
      message: 'A record with the same unique value already exists',
    };
  }
  if (isForeignKeyViolation(error)) {
    return {
      statusCode: 409,
      code: 'RESOURCE_IN_USE',
      message: 'The record is referenced by other records',
    };
  }

  return {
    statusCode: 500,
    code: 'INTERNAL_ERROR',
    message: 'Internal server error',
  };
}

/** Per-request config + database handle. */
const requestContext: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('config', loadConfig(c.env));
  c.set('db', getDb(c.env.DB));
  await next();
};

const corsByConfig = new WeakMap<Config, MiddlewareHandler>();
const corsFromConfig: MiddlewareHandler<AppEnv> = async (c, next) => {
  const config = c.var.config;
  if (config.CORS_ORIGINS.length === 0) return next();
  let handler = corsByConfig.get(config);
  if (!handler) {
    handler = cors({ origin: config.CORS_ORIGINS });
    corsByConfig.set(config, handler);
  }
  return handler(c, next);
};

export function createApp() {
  const api = new Hono<AppEnv>()
    .get('/health', async (c) => {
      await c.var.db.run(sql`SELECT 1`);
      return c.json({ status: 'ok', database: 'up', serverTime: new Date() });
    })
    .route('/auth', authRoutes)
    .route('/topics', topicRoutes)
    .route('/domains', domainRoutes)
    .route('/questions', questionRoutes)
    .route('/exams', examRoutes)
    .route('/catalog/exams', catalogRoutes)
    .route('/catalog/questions', questionBankRoutes)
    .route('/attempts', attemptRoutes);

  const app = new Hono<AppEnv>();
  app.use(secureHeaders());
  app.use(requestContext);
  app.use(corsFromConfig);
  app.use(
    bodyLimit({
      maxSize: 100 * 1024,
      onError: (c) =>
        c.json(
          {
            statusCode: 413,
            code: 'PAYLOAD_TOO_LARGE',
            message: 'Request body is too large',
          } satisfies ErrorBody,
          413,
        ),
    }),
  );
  app.route(API_PREFIX, api);
  // Opening the bare URL in a browser should not look like an error.
  app.get('/', (c) =>
    c.json({
      name: 'Q Bank API',
      api: API_PREFIX,
      health: `${API_PREFIX}/health`,
    }),
  );

  app.notFound((c) =>
    c.json(
      {
        statusCode: 404,
        code: 'NOT_FOUND',
        message: `Cannot ${c.req.method} ${c.req.path}`,
      } satisfies ErrorBody,
      404,
    ),
  );
  app.onError((error, c) => {
    const body = toErrorBody(error);
    if (body.statusCode >= 500) console.error(error);
    return c.json(body, body.statusCode as ContentfulStatusCode);
  });
  return app;
}
