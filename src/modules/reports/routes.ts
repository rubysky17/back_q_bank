import { Hono } from 'hono';

import { requireAuth } from '../../auth/middleware';
import type { AppEnv } from '../../env';
import { idParam, parseQuery } from '../../lib/validation';
import {
  compareQuery,
  compareReports,
  examReport,
  listReportExams,
} from './service';

/** Statistics over the signed-in user's own finished attempts. */
export const reportRoutes = new Hono<AppEnv>()
  .use(requireAuth)

  /** Exams the user has finished at least once, most recent first. */
  .get('/exams', async (c) =>
    c.json(await listReportExams(c.var.db, c.var.user)),
  )

  /** % correct, time per answer, outcomes, trend over attempts and per-domain breakdown of one exam. */
  .get('/exams/:examId', async (c) =>
    c.json(await examReport(c.var.db, c.var.user, idParam(c, 'examId'))),
  )

  /** The same report for 2–5 exams: `?examIds=a,b,c`. */
  .get('/compare', async (c) => {
    const { examIds } = parseQuery(c, compareQuery);
    return c.json(await compareReports(c.var.db, c.var.user, examIds));
  });
