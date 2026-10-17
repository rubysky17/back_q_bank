import { Hono } from 'hono';

import { requireAuth, requireRole } from '../../auth/middleware';
import type { AppEnv } from '../../env';
import { idParam, parseBody, parseQuery } from '../../lib/validation';
import {
  archiveExam,
  createExam,
  createExamSchema,
  getExam,
  listExams,
  listExamsQuery,
  publishExam,
  removeExam,
  unpublishExam,
  updateExam,
  updateExamSchema,
} from './service';
import {
  addExamQuestionsSchema,
  addQuestions,
  addSection,
  createSectionSchema,
  removeExamQuestion,
  removeSection,
  reorderQuestions,
  reorderQuestionsSchema,
  reorderSections,
  reorderSectionsSchema,
  updateExamQuestion,
  updateExamQuestionSchema,
  updateSection,
  updateSectionSchema,
} from './structure';

/**
 * Exam authoring for hosts (admins can manage every exam).
 * Structure endpoints return the full exam so the editor can re-render from one response.
 */
export const examRoutes = new Hono<AppEnv>()
  .use(requireAuth, requireRole('HOST', 'ADMIN'))

  .get('/', async (c) => {
    const query = parseQuery(c, listExamsQuery);
    return c.json(await listExams(c.var.db, c.var.user, query));
  })

  .post('/', async (c) => {
    const input = await parseBody(c, createExamSchema);
    return c.json(await createExam(c.var.db, c.var.user, input), 201);
  })

  /** Full exam including sections, questions and correct answers. */
  .get('/:id', async (c) =>
    c.json(await getExam(c.var.db, c.var.user, idParam(c))),
  )

  .patch('/:id', async (c) => {
    const id = idParam(c);
    const input = await parseBody(c, updateExamSchema);
    return c.json(await updateExam(c.var.db, c.var.user, id, input));
  })

  .delete('/:id', async (c) => {
    await removeExam(c.var.db, c.var.user, idParam(c));
    return c.body(null, 204);
  })

  .post('/:id/publish', async (c) =>
    c.json(await publishExam(c.var.db, c.var.user, idParam(c))),
  )

  .post('/:id/unpublish', async (c) =>
    c.json(await unpublishExam(c.var.db, c.var.user, idParam(c))),
  )

  .post('/:id/archive', async (c) =>
    c.json(await archiveExam(c.var.db, c.var.user, idParam(c))),
  )

  .post('/:id/sections', async (c) => {
    const id = idParam(c);
    const input = await parseBody(c, createSectionSchema);
    return c.json(await addSection(c.var.db, c.var.user, id, input), 201);
  })

  .put('/:id/sections/order', async (c) => {
    const id = idParam(c);
    const input = await parseBody(c, reorderSectionsSchema);
    return c.json(await reorderSections(c.var.db, c.var.user, id, input));
  })

  .patch('/:id/sections/:sectionId', async (c) => {
    const id = idParam(c);
    const sectionId = idParam(c, 'sectionId');
    const input = await parseBody(c, updateSectionSchema);
    return c.json(
      await updateSection(c.var.db, c.var.user, id, sectionId, input),
    );
  })

  .delete('/:id/sections/:sectionId', async (c) => {
    const id = idParam(c);
    const sectionId = idParam(c, 'sectionId');
    return c.json(await removeSection(c.var.db, c.var.user, id, sectionId));
  })

  .post('/:id/sections/:sectionId/questions', async (c) => {
    const id = idParam(c);
    const sectionId = idParam(c, 'sectionId');
    const input = await parseBody(c, addExamQuestionsSchema);
    return c.json(
      await addQuestions(c.var.db, c.var.user, id, sectionId, input),
      201,
    );
  })

  .put('/:id/sections/:sectionId/questions/order', async (c) => {
    const id = idParam(c);
    const sectionId = idParam(c, 'sectionId');
    const input = await parseBody(c, reorderQuestionsSchema);
    return c.json(
      await reorderQuestions(c.var.db, c.var.user, id, sectionId, input),
    );
  })

  .patch('/:id/questions/:questionId', async (c) => {
    const id = idParam(c);
    const questionId = idParam(c, 'questionId');
    const input = await parseBody(c, updateExamQuestionSchema);
    return c.json(
      await updateExamQuestion(c.var.db, c.var.user, id, questionId, input),
    );
  })

  .delete('/:id/questions/:questionId', async (c) => {
    const id = idParam(c);
    const questionId = idParam(c, 'questionId');
    return c.json(
      await removeExamQuestion(c.var.db, c.var.user, id, questionId),
    );
  });
