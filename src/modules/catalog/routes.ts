import { Hono } from 'hono';

import { requireAuth } from '../../auth/middleware';
import type { AppEnv } from '../../env';
import { idParam, parseBody, parseQuery } from '../../lib/validation';
import { startAttempt, startAttemptSchema } from '../attempts/service';
import { catalogQuery, getCatalogExam, listCatalog } from './service';

export const catalogRoutes = new Hono<AppEnv>()
  .use(requireAuth)

  .get('/', async (c) => {
    const query = parseQuery(c, catalogQuery);
    return c.json(await listCatalog(c.var.db, query));
  })

  .get('/:id', async (c) =>
    c.json(await getCatalogExam(c.var.db, c.var.user, idParam(c))),
  )

  /**
   * Starts an attempt, or returns the one in progress (`resumed: true`).
   * Body `{ "fresh": true }` abandons the one in progress and starts over.
   */
  .post('/:id/attempts', async (c) => {
    const id = idParam(c);
    const options = await parseBody(c, startAttemptSchema);
    return c.json(await startAttempt(c.var.db, c.var.user, id, options), 201);
  });
