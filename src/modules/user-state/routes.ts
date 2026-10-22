import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';

import { requireAuth } from '../../auth/middleware';
import type { AppEnv } from '../../env';
import { AppError } from '../../lib/app-error';
import { parseBody } from '../../lib/validation';
import { syncStatus, syncUserState, syncUserStateSchema } from './service';

/** Per signed-in user (no-op when the binding is absent, e.g. in tests). */
const userStateRateLimit = createMiddleware<AppEnv>(async (c, next) => {
  const limiter = c.env.USER_STATE_LIMITER as RateLimit | undefined;
  if (limiter) {
    const { success } = await limiter.limit({ key: c.var.user.id });
    if (!success) throw AppError.tooManyRequests();
  }
  await next();
});

/** The signed-in user's state shared by their devices (offline-first: the apps keep a copy). */
export const userStateRoutes = new Hono<AppEnv>()
  .use(requireAuth)
  .use(userStateRateLimit)

  /** Uploads local changes (practice answers, settings) and returns what changed since `cursor`. */
  .post('/sync', async (c) => {
    const input = await parseBody(c, syncUserStateSchema);
    return c.json(await syncUserState(c.var.db, c.var.user, input));
  })

  /** Change markers the apps poll while open, to sync only what another device changed. */
  .get('/sync-status', async (c) =>
    c.json(await syncStatus(c.var.db, c.var.user)),
  );
