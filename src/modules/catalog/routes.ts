import { Hono } from 'hono';

import { requireAuth } from '../../auth/middleware';
import type { AppEnv } from '../../env';
import { idParam, parseQuery } from '../../lib/validation';
import { startAttempt } from '../attempts/service';
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

  /** Starts an attempt, or returns the one in progress (`resumed: true`). */
  .post('/:id/attempts', async (c) =>
    c.json(await startAttempt(c.var.db, c.var.user, idParam(c)), 201),
  );
