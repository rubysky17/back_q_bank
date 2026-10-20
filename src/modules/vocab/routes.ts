import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';

import { requireAuth } from '../../auth/middleware';
import type { AppEnv } from '../../env';
import { AppError } from '../../lib/app-error';
import { parseBody } from '../../lib/validation';
import { syncVocab, syncVocabSchema } from './service';
import { freeTranslator } from './translator';

/** Syncs per signed-in user (no-op when the binding is absent, e.g. in tests). */
const vocabRateLimit = createMiddleware<AppEnv>(async (c, next) => {
  const limiter = c.env.VOCAB_LIMITER as RateLimit | undefined;
  if (limiter) {
    const { success } = await limiter.limit({ key: c.var.user.id });
    if (!success) throw AppError.tooManyRequests();
  }
  await next();
});

/** The signed-in user's vocabulary notes (offline-first: the apps keep their own copy). */
export const vocabRoutes = new Hono<AppEnv>()
  .use(requireAuth)
  .use(vocabRateLimit)

  /** Uploads local changes and returns what changed since `cursor`, translating up to 5 notes. */
  .post('/sync', async (c) => {
    const input = await parseBody(c, syncVocabSchema);
    return c.json(await syncVocab(c.var.db, freeTranslator, c.var.user, input));
  });
