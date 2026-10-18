import { Hono } from 'hono';

import { requireAuth } from '../../auth/middleware';
import type { AppEnv } from '../../env';
import { parseQuery } from '../../lib/validation';
import { bankFacets, bankQuery, listBankQuestions } from './service';

/** Questions of published exams for self-study (answers included), for any signed-in user. */
export const questionBankRoutes = new Hono<AppEnv>()
  .use(requireAuth)

  .get('/', async (c) => {
    const query = parseQuery(c, bankQuery);
    return c.json(await listBankQuestions(c.var.db, query));
  })

  .get('/facets', async (c) => c.json(await bankFacets(c.var.db)));
