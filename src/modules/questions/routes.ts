import { Hono } from 'hono';

import { requireAuth, requireRole } from '../../auth/middleware';
import type { AppEnv } from '../../env';
import { idParam, parseBody, parseQuery } from '../../lib/validation';
import {
  createQuestion,
  createQuestionSchema,
  getQuestion,
  listQuestions,
  listQuestionsQuery,
  removeQuestion,
  updateQuestion,
  updateQuestionSchema,
} from './service';

/** The host's own question bank (admins see every host's questions). */
export const questionRoutes = new Hono<AppEnv>()
  .use(requireAuth, requireRole('HOST', 'ADMIN'))

  .get('/', async (c) => {
    const query = parseQuery(c, listQuestionsQuery);
    return c.json(await listQuestions(c.var.db, c.var.user, query));
  })

  .post('/', async (c) => {
    const input = await parseBody(c, createQuestionSchema);
    return c.json(await createQuestion(c.var.db, c.var.user, input), 201);
  })

  .get('/:id', async (c) =>
    c.json(await getQuestion(c.var.db, c.var.user, idParam(c))),
  )

  .patch('/:id', async (c) => {
    const id = idParam(c);
    const input = await parseBody(c, updateQuestionSchema);
    return c.json(await updateQuestion(c.var.db, c.var.user, id, input));
  })

  .delete('/:id', async (c) => {
    await removeQuestion(c.var.db, c.var.user, idParam(c));
    return c.body(null, 204);
  });
