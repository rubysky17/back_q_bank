import { asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Db } from '../../db/client';
import { domains, exams, questions, topics } from '../../db/schema';
import { type AuthUser, isAdmin } from '../../lib/access';
import { AppError } from '../../lib/app-error';
import { slugify } from '../../lib/slugify';
import { countAll, inList, qualified } from '../../lib/sql';
import { zName } from '../../lib/validation';

export const createTopicSchema = z.strictObject({
  /** e.g. "PMP" */
  name: zName(120),
  description: z.string().max(2000).nullish(),
});
export const updateTopicSchema = createTopicSchema.partial();

export const createDomainSchema = z.strictObject({
  /** e.g. "People", "Process", "Business Environment" */
  name: zName(120),
  description: z.string().max(2000).nullish(),
  /** Display order inside the topic; defaults to the end of the list. */
  order: z.number().int().min(0).optional(),
});
export const updateDomainSchema = createDomainSchema.partial();

type CreateTopicInput = z.infer<typeof createTopicSchema>;
type UpdateTopicInput = z.infer<typeof updateTopicSchema>;
type CreateDomainInput = z.infer<typeof createDomainSchema>;
type UpdateDomainInput = z.infer<typeof updateDomainSchema>;

const domainColumns = {
  id: domains.id,
  topicId: domains.topicId,
  name: domains.name,
  description: domains.description,
  order: domains.order,
  createdById: domains.createdById,
};

const topicColumns = {
  id: topics.id,
  name: topics.name,
  slug: topics.slug,
  description: topics.description,
  createdById: topics.createdById,
  createdAt: topics.createdAt,
  updatedAt: topics.updatedAt,
};

type TopicRow = { id: string; createdById: string };

/** Topics and domains are shared by all hosts; only their creator or an admin may change them. */
function assertCreator(createdById: string, user: AuthUser) {
  if (!isAdmin(user) && createdById !== user.id) {
    throw AppError.forbidden('Only the creator or an admin can change this');
  }
}

async function attachDomains<T extends TopicRow>(db: Db, rows: T[]) {
  if (rows.length === 0) return [];
  const list = await db
    .select(domainColumns)
    .from(domains)
    .where(
      inList(
        domains.topicId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(asc(domains.order), asc(domains.name), asc(domains.id));
  const byTopic = new Map<string, typeof list>();
  for (const domain of list) {
    byTopic.set(domain.topicId, [
      ...(byTopic.get(domain.topicId) ?? []),
      domain,
    ]);
  }
  return rows.map((row) => ({ ...row, domains: byTopic.get(row.id) ?? [] }));
}

export async function listTopics(db: Db) {
  const rows = await db
    .select(topicColumns)
    .from(topics)
    .orderBy(asc(topics.name), asc(topics.id));
  return attachDomains(db, rows);
}

export async function getTopic(db: Db, id: string) {
  const [row] = await db
    .select(topicColumns)
    .from(topics)
    .where(eq(topics.id, id));
  if (!row) throw AppError.notFound('Topic');
  const [topic] = await attachDomains(db, [row]);
  return topic;
}

export async function createTopic(
  db: Db,
  user: AuthUser,
  input: CreateTopicInput,
) {
  const slug = await uniqueSlug(db, input.name);
  const [topic] = await db
    .insert(topics)
    .values({
      name: input.name,
      slug,
      description: input.description,
      createdById: user.id,
    })
    .returning(topicColumns);
  return { ...topic, domains: [] };
}

export async function updateTopic(
  db: Db,
  user: AuthUser,
  id: string,
  input: UpdateTopicInput,
) {
  const current = await getTopic(db, id);
  assertCreator(current.createdById, user);
  const slug =
    input.name !== undefined ? await uniqueSlug(db, input.name, id) : undefined;
  const [topic] = await db
    .update(topics)
    .set({ name: input.name, slug, description: input.description })
    .where(eq(topics.id, id))
    .returning(topicColumns);
  if (!topic) throw AppError.notFound('Topic');
  return { ...topic, domains: current.domains };
}

export async function removeTopic(db: Db, user: AuthUser, id: string) {
  const topic = await getTopic(db, id);
  assertCreator(topic.createdById, user);
  const [{ questionCount, examCount }] = await db
    .select({
      questionCount: sql<number>`(SELECT count(*) FROM ${questions} WHERE ${qualified(questions.topicId)} = ${qualified(topics.id)})`,
      examCount: sql<number>`(SELECT count(*) FROM ${exams} WHERE ${qualified(exams.topicId)} = ${qualified(topics.id)})`,
    })
    .from(topics)
    .where(eq(topics.id, id));
  if (questionCount > 0 || examCount > 0) {
    throw AppError.conflict(
      'TOPIC_IN_USE',
      `Topic is used by ${questionCount} question(s) and ${examCount} exam(s)`,
      { questions: questionCount, exams: examCount },
    );
  }
  await db.delete(topics).where(eq(topics.id, id));
}

export async function createDomain(
  db: Db,
  user: AuthUser,
  topicId: string,
  input: CreateDomainInput,
) {
  await getTopic(db, topicId);
  await assertDomainNameFree(db, topicId, input.name);
  let order = input.order;
  if (order === undefined) {
    const [{ count }] = await db
      .select({ count: countAll() })
      .from(domains)
      .where(eq(domains.topicId, topicId));
    order = count;
  }
  const [domain] = await db
    .insert(domains)
    .values({
      topicId,
      name: input.name,
      description: input.description,
      order,
      createdById: user.id,
    })
    .returning(domainColumns);
  return domain;
}

export async function updateDomain(
  db: Db,
  user: AuthUser,
  id: string,
  input: UpdateDomainInput,
) {
  const domain = await getDomain(db, id);
  assertCreator(domain.createdById, user);
  if (input.name !== undefined) {
    await assertDomainNameFree(db, domain.topicId, input.name, id);
  }
  const [updated] = await db
    .update(domains)
    .set({
      name: input.name,
      description: input.description,
      order: input.order,
    })
    .where(eq(domains.id, id))
    .returning(domainColumns);
  if (!updated) throw AppError.notFound('Domain');
  return updated;
}

export async function removeDomain(db: Db, user: AuthUser, id: string) {
  const domain = await getDomain(db, id);
  assertCreator(domain.createdById, user);
  const [{ count }] = await db
    .select({ count: countAll() })
    .from(questions)
    .where(eq(questions.domainId, id));
  if (count > 0) {
    throw AppError.conflict(
      'DOMAIN_IN_USE',
      `Domain is used by ${count} question(s)`,
      { questions: count },
    );
  }
  await db.delete(domains).where(eq(domains.id, id));
}

async function getDomain(db: Db, id: string) {
  const [domain] = await db
    .select(domainColumns)
    .from(domains)
    .where(eq(domains.id, id));
  if (!domain) throw AppError.notFound('Domain');
  return domain;
}

async function uniqueSlug(db: Db, name: string, exceptId?: string) {
  const slug = slugify(name);
  if (!slug) {
    throw AppError.badRequest(
      'INVALID_NAME',
      'Name must contain letters or digits',
    );
  }
  const [clash] = await db
    .select({ id: topics.id })
    .from(topics)
    .where(eq(topics.slug, slug));
  if (clash && clash.id !== exceptId) {
    throw AppError.conflict('TOPIC_EXISTS', `Topic "${name}" already exists`, {
      topicId: clash.id,
    });
  }
  return slug;
}

/** Domain names are unique per topic regardless of case (compared in JS: SQLite lower() is ASCII-only). */
async function assertDomainNameFree(
  db: Db,
  topicId: string,
  name: string,
  exceptId?: string,
) {
  const wanted = name.toLowerCase();
  const existing = await db
    .select({ id: domains.id, name: domains.name })
    .from(domains)
    .where(eq(domains.topicId, topicId));
  const clash = existing.find(
    (domain) => domain.id !== exceptId && domain.name.toLowerCase() === wanted,
  );
  if (clash) {
    throw AppError.conflict(
      'DOMAIN_EXISTS',
      `Domain "${name}" already exists in this topic`,
      { domainId: clash.id },
    );
  }
}
