import { Hono } from 'hono';

import { requireAuth, requireRole } from '../../auth/middleware';
import type { AppEnv } from '../../env';
import { idParam, parseBody } from '../../lib/validation';
import {
  createDomain,
  createDomainSchema,
  createTopic,
  createTopicSchema,
  getTopic,
  listTopics,
  removeDomain,
  removeTopic,
  updateDomain,
  updateDomainSchema,
  updateTopic,
  updateTopicSchema,
} from './service';

const authors = requireRole('HOST', 'ADMIN');

export const topicRoutes = new Hono<AppEnv>()
  .use(requireAuth)

  /** All topics with their domains (any signed-in user). */
  .get('/', async (c) => c.json(await listTopics(c.var.db)))

  .get('/:id', async (c) => c.json(await getTopic(c.var.db, idParam(c))))

  .post('/', authors, async (c) => {
    const input = await parseBody(c, createTopicSchema);
    return c.json(await createTopic(c.var.db, c.var.user, input), 201);
  })

  .patch('/:id', authors, async (c) => {
    const id = idParam(c);
    const input = await parseBody(c, updateTopicSchema);
    return c.json(await updateTopic(c.var.db, c.var.user, id, input));
  })

  /** Fails with 409 TOPIC_IN_USE while questions or exams use the topic. */
  .delete('/:id', authors, async (c) => {
    await removeTopic(c.var.db, c.var.user, idParam(c));
    return c.body(null, 204);
  })

  .post('/:topicId/domains', authors, async (c) => {
    const topicId = idParam(c, 'topicId');
    const input = await parseBody(c, createDomainSchema);
    return c.json(
      await createDomain(c.var.db, c.var.user, topicId, input),
      201,
    );
  });

export const domainRoutes = new Hono<AppEnv>()
  .use(requireAuth, authors)

  .patch('/:id', async (c) => {
    const id = idParam(c);
    const input = await parseBody(c, updateDomainSchema);
    return c.json(await updateDomain(c.var.db, c.var.user, id, input));
  })

  /** Fails with 409 DOMAIN_IN_USE while questions are tagged with it. */
  .delete('/:id', async (c) => {
    await removeDomain(c.var.db, c.var.user, idParam(c));
    return c.body(null, 204);
  });
