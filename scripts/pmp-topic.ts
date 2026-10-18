/** The PMP topic and its domains, shared by the seed and the PMP import. */
export type DomainKey = 'people' | 'process' | 'business';

export const PMP_TOPIC = {
  name: 'PMP',
  slug: 'pmp',
  description: 'Project Management Professional certification (PMI).',
};

export const DOMAINS: { key: DomainKey; name: string; description: string }[] =
  [
    {
      key: 'people',
      name: 'People',
      description:
        'Leading and supporting the project team (42% of the PMP exam).',
    },
    {
      key: 'process',
      name: 'Process',
      description:
        'Technical aspects of managing a project (50% of the PMP exam).',
    },
    {
      key: 'business',
      name: 'Business Environment',
      description:
        'Connecting projects to organizational strategy (8% of the PMP exam).',
    },
  ];

/**
 * Idempotent SQL for the topic and its domains. `owner` is an SQL expression for the creator's id,
 * `newId` makes the ids of rows that do not exist yet.
 */
export function topicSql(
  owner: string,
  now: number,
  newId: () => string,
  lit: (value: string) => string,
): string[] {
  const topic = `(SELECT "id" FROM "Topic" WHERE "slug" = ${lit(PMP_TOPIC.slug)})`;
  return [
    `INSERT INTO "Topic" ("id", "name", "slug", "description", "createdById", "createdAt", "updatedAt")
VALUES (${lit(newId())}, ${lit(PMP_TOPIC.name)}, ${lit(PMP_TOPIC.slug)}, ${lit(PMP_TOPIC.description)}, ${owner}, ${now}, ${now})
ON CONFLICT ("slug") DO NOTHING;`,
    ...DOMAINS.map(
      (domain, order) =>
        `INSERT INTO "Domain" ("id", "topicId", "name", "description", "order", "createdById", "createdAt", "updatedAt")
VALUES (${lit(newId())}, ${topic}, ${lit(domain.name)}, ${lit(domain.description)}, ${order}, ${owner}, ${now}, ${now})
ON CONFLICT ("topicId", "name") DO NOTHING;`,
    ),
  ];
}
