import { Hono } from 'hono';

import { requireAuth } from '../../auth/middleware';
import type { AppEnv } from '../../env';
import { idParam, parseBody, parseQuery } from '../../lib/validation';
import {
  attemptResult,
  attemptReview,
  getAttempt,
  listAttempts,
  listAttemptsQuery,
  saveAnswers,
  saveAnswersSchema,
  submitAttempt,
} from './service';

/** The signed-in user's own attempts. Start one with POST /catalog/exams/:id/attempts. */
export const attemptRoutes = new Hono<AppEnv>()
  .use(requireAuth)

  .get('/', async (c) => {
    const query = parseQuery(c, listAttemptsQuery);
    return c.json(await listAttempts(c.var.db, c.var.user, query));
  })

  /** Questions (without answers), saved responses, `expiresAt` and `serverTime` for the timer. */
  .get('/:id', async (c) =>
    c.json(await getAttempt(c.var.db, c.var.user, idParam(c))),
  )

  .patch('/:id/answers', async (c) => {
    const id = idParam(c);
    const input = await parseBody(c, saveAnswersSchema);
    return c.json(await saveAnswers(c.var.db, c.var.user, id, input));
  })

  /** Grades the attempt and returns the result. Safe to retry. */
  .post('/:id/submit', async (c) =>
    c.json(await submitAttempt(c.var.db, c.var.user, idParam(c))),
  )

  /** Score, pass/fail and breakdown by section, domain and difficulty. */
  .get('/:id/result', async (c) =>
    c.json(await attemptResult(c.var.db, c.var.user, idParam(c))),
  )

  /** Every question with the user's answer, the correct answer and the explanation. */
  .get('/:id/review', async (c) =>
    c.json(await attemptReview(c.var.db, c.var.user, idParam(c))),
  );
