/**
 * Idempotent seed for D1: `npm run db:seed` (local) or `npm run db:seed:remote` (production).
 * - The ADMIN account (ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME). Its password hash is (re)set on every
 *   run, so this is also how to change the admin password.
 * - Topic PMP with its 3 domains, 9 single-choice questions and a published 3-section mock exam
 *   (skipped with `--admin-only`)
 *
 * Builds one SQL file and runs it with `wrangler d1 execute`. Re-running skips what already exists.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

import { config } from 'dotenv';

import { hashPassword } from '../src/auth/password';
import { configSchema } from '../src/env';
import { searchKey } from '../src/lib/slugify';
import { uuidv7 } from '../src/lib/uuidv7';

config({ quiet: true });

const remote = process.argv.includes('--remote');
const adminOnly = process.argv.includes('--admin-only');
const ADMIN_PASSWORD_MIN_LENGTH = 12;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required to seed the database`);
  return value;
}

/** SQL literal (wrangler d1 execute --file takes no bound parameters). */
const lit = (value: string | number | boolean | null): string => {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${value.replaceAll("'", "''")}'`;
};

type DomainKey = 'people' | 'process' | 'business';

const DOMAINS: { key: DomainKey; name: string; description: string }[] = [
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

const QUESTIONS: {
  domain: DomainKey;
  difficulty: 'EASY' | 'MEDIUM' | 'HARD';
  content: string;
  options: string[];
  correct: number;
  explanation: string;
}[] = [
  {
    domain: 'people',
    difficulty: 'MEDIUM',
    content:
      'Two senior team members disagree strongly about the technical approach for a key deliverable, and the conflict is starting to affect team morale. What should the project manager do FIRST?',
    options: [
      'Escalate the conflict to the project sponsor',
      'Meet with both team members to understand their perspectives and collaborate on a solution',
      'Choose one approach and instruct both team members to follow it',
      'Reassign one of the team members to another work package',
    ],
    correct: 1,
    explanation:
      'Collaborating/problem solving addresses the root cause and is the preferred conflict resolution technique. The project manager should handle it directly before escalating.',
  },
  {
    domain: 'people',
    difficulty: 'EASY',
    content:
      'A new developer joins an agile team in the middle of the project. What is the BEST way to help them become productive quickly?',
    options: [
      'Give them the project documentation to read on their own',
      'Assign them the most critical user story so they learn fast',
      'Pair them with an experienced team member',
      'Keep them out of team ceremonies until they are fully onboarded',
    ],
    correct: 2,
    explanation:
      'Pairing transfers knowledge quickly and integrates the new member into the team.',
  },
  {
    domain: 'people',
    difficulty: 'HARD',
    content:
      'Members of a virtual team spread across four time zones complain that they are frequently left out of decisions. What should the project manager do?',
    options: [
      'Hold all meetings in the project manager’s time zone',
      'Make decisions centrally and share them by email',
      'Ask the sponsor to co-locate the team',
      'Work with the team to create a team charter with agreed core hours and decision-making norms',
    ],
    correct: 3,
    explanation:
      'A team charter created with the team sets working agreements (core collaboration hours, how decisions are made) that keep everyone included.',
  },
  {
    domain: 'process',
    difficulty: 'MEDIUM',
    content:
      'A key stakeholder asks for a new feature after the scope baseline has been approved. What should the project manager do?',
    options: [
      'Add the feature immediately to keep the stakeholder satisfied',
      'Assess the impact and submit a change request through integrated change control',
      'Refuse the request because the baseline is approved',
      'Ask the team to work overtime to absorb the extra work',
    ],
    correct: 1,
    explanation:
      'Changes to an approved baseline go through integrated change control after their impact on scope, schedule, cost and quality is analyzed.',
  },
  {
    domain: 'process',
    difficulty: 'EASY',
    content:
      'Which document describes how project risks will be identified, analyzed, responded to and monitored?',
    options: [
      'Risk register',
      'Risk management plan',
      'Issue log',
      'Risk report',
    ],
    correct: 1,
    explanation:
      'The risk management plan defines how risk management activities are structured and performed. The risk register records the individual risks.',
  },
  {
    domain: 'process',
    difficulty: 'HARD',
    content:
      'A project has a CPI of 0.85 and an SPI of 1.10. What does this indicate?',
    options: [
      'Under budget and behind schedule',
      'Over budget and behind schedule',
      'Over budget and ahead of schedule',
      'Under budget and ahead of schedule',
    ],
    correct: 2,
    explanation:
      'CPI < 1 means more is being spent than the value earned (over budget); SPI > 1 means work is progressing faster than planned (ahead of schedule).',
  },
  {
    domain: 'business',
    difficulty: 'MEDIUM',
    content:
      'A new government regulation that affects your product is announced in the middle of the project. What should the project manager do FIRST?',
    options: [
      'Continue as planned until the regulation takes effect',
      'Assess the impact of the regulation on the project with the relevant experts',
      'Recommend cancelling the project',
      'Ask the team to implement changes right away',
    ],
    correct: 1,
    explanation:
      'Compliance changes must first be analyzed for impact; the results then drive change requests and updated plans.',
  },
  {
    domain: 'business',
    difficulty: 'EASY',
    content: 'What is the PRIMARY purpose of a business case?',
    options: [
      'To define the detailed project requirements',
      'To assign resources to project activities',
      'To justify the investment by describing the expected business value',
      'To document lessons learned',
    ],
    correct: 2,
    explanation:
      'The business case documents the economic feasibility and expected benefits used to justify (and later re-validate) the project.',
  },
  {
    domain: 'business',
    difficulty: 'HARD',
    content:
      'Midway through the project, the organization changes its strategy and the project’s expected benefits no longer align with business goals. What should the project manager do?',
    options: [
      'Complete the project as originally chartered',
      'Change the scope to match the new strategy without waiting for approval',
      'Stop all work immediately and release the team',
      'Raise the issue with the sponsor so the project’s viability can be re-evaluated',
    ],
    correct: 3,
    explanation:
      'Benefits realization must stay aligned with strategy. The sponsor owns the business case and decides whether to continue, change or terminate the project.',
  },
];

const EXAM_TITLE = 'PMP Mock Test 1';

async function buildSql(): Promise<string> {
  const email = requireEnv('ADMIN_EMAIL').toLowerCase();
  const password = requireEnv('ADMIN_PASSWORD');
  if (password.length < ADMIN_PASSWORD_MIN_LENGTH) {
    throw new Error(
      `ADMIN_PASSWORD must be at least ${ADMIN_PASSWORD_MIN_LENGTH} characters`,
    );
  }
  // Same cost as the Worker (PASSWORD_HASH_ITERATIONS or its default).
  const iterations = configSchema.shape.PASSWORD_HASH_ITERATIONS.parse(
    process.env.PASSWORD_HASH_ITERATIONS,
  );
  const passwordHash = await hashPassword(password, iterations);
  const fullName = process.env.ADMIN_NAME?.trim() || 'Admin';
  const now = Date.now();
  const owner = `(SELECT "id" FROM "User" WHERE "email" = ${lit(email)})`;
  const topic = `(SELECT "id" FROM "Topic" WHERE "slug" = 'pmp')`;
  const examMissing = `NOT EXISTS (SELECT 1 FROM "Exam" WHERE "title" = ${lit(EXAM_TITLE)} AND "ownerId" = ${owner})`;
  const sql: string[] = [];

  sql.push(`INSERT INTO "User" ("id", "email", "passwordHash", "fullName", "role", "isActive", "createdAt", "updatedAt")
VALUES (${lit(uuidv7())}, ${lit(email)}, ${lit(passwordHash)}, ${lit(fullName)}, 'ADMIN', 1, ${now}, ${now})
ON CONFLICT ("email") DO UPDATE SET "role" = 'ADMIN', "passwordHash" = excluded."passwordHash", "updatedAt" = ${now};`);
  if (adminOnly) return sql.join('\n\n') + '\n';

  sql.push(`INSERT INTO "Topic" ("id", "name", "slug", "description", "createdById", "createdAt", "updatedAt")
VALUES (${lit(uuidv7())}, 'PMP', 'pmp', 'Project Management Professional certification (PMI).', ${owner}, ${now}, ${now})
ON CONFLICT ("slug") DO NOTHING;`);

  for (const [order, domain] of DOMAINS.entries()) {
    sql.push(`INSERT INTO "Domain" ("id", "topicId", "name", "description", "order", "createdById", "createdAt", "updatedAt")
VALUES (${lit(uuidv7())}, ${topic}, ${lit(domain.name)}, ${lit(domain.description)}, ${order}, ${owner}, ${now}, ${now})
ON CONFLICT ("topicId", "name") DO NOTHING;`);
  }

  // Questions, exam, sections and placements only when the mock exam does not exist yet.
  const questionIds = QUESTIONS.map(() => uuidv7());
  for (const [index, question] of QUESTIONS.entries()) {
    const definition = {
      options: question.options.map((content, i) => ({
        id: randomUUID(),
        content,
        isCorrect: i === question.correct,
      })),
    };
    const domainName = DOMAINS.find((d) => d.key === question.domain)!.name;
    sql.push(`INSERT INTO "Question" ("id", "ownerId", "topicId", "domainId", "type", "difficulty", "content", "searchText", "explanation", "definition", "version", "createdAt", "updatedAt")
SELECT ${lit(questionIds[index])}, ${owner}, ${topic},
  (SELECT "id" FROM "Domain" WHERE "topicId" = ${topic} AND "name" = ${lit(domainName)}),
  'SINGLE_CHOICE', ${lit(question.difficulty)}, ${lit(question.content)}, ${lit(searchKey(question.content))},
  ${lit(question.explanation)}, ${lit(JSON.stringify(definition))}, 1, ${now + index}, ${now + index}
WHERE ${examMissing};`);
  }

  const examId = uuidv7();
  const description =
    'Mini mock exam with the real PMP layout: 3 sections (the real exam has 60 questions per section). Each section mixes all three domains.';
  sql.push(`INSERT INTO "Exam" ("id", "ownerId", "topicId", "title", "searchText", "description", "status", "durationMinutes", "passingScore", "shuffleQuestions", "shuffleOptions", "publishedAt", "createdAt", "updatedAt")
SELECT ${lit(examId)}, ${owner}, ${topic}, ${lit(EXAM_TITLE)}, ${lit(searchKey(EXAM_TITLE))}, ${lit(description)},
  'PUBLISHED', 15, 70, 0, 1, ${now}, ${now}, ${now}
WHERE ${examMissing};`);

  // Section n gets the n-th question of each domain (People, Process, Business Environment).
  for (const order of [1, 2, 3]) {
    const sectionId = uuidv7();
    sql.push(`INSERT INTO "ExamSection" ("id", "examId", "title", "order", "createdAt", "updatedAt")
SELECT ${lit(sectionId)}, ${lit(examId)}, ${lit(`Section ${order}`)}, ${order}, ${now}, ${now}
WHERE EXISTS (SELECT 1 FROM "Exam" WHERE "id" = ${lit(examId)});`);
    for (const [index, offset] of [0, 3, 6].entries()) {
      sql.push(`INSERT INTO "ExamQuestion" ("id", "examId", "sectionId", "questionId", "order", "points", "createdAt")
SELECT ${lit(uuidv7())}, ${lit(examId)}, ${lit(sectionId)}, ${lit(questionIds[offset + order - 1])}, ${index + 1}, 1, ${now}
WHERE EXISTS (SELECT 1 FROM "ExamSection" WHERE "id" = ${lit(sectionId)});`);
    }
  }
  return sql.join('\n\n') + '\n';
}

mkdirSync('.wrangler', { recursive: true });
const file = '.wrangler/seed.sql';
writeFileSync(file, await buildSql());
execFileSync(
  'npx',
  [
    'wrangler',
    'd1',
    'execute',
    'DB',
    remote ? '--remote' : '--local',
    '--file',
    file,
    '--yes',
  ],
  { stdio: 'inherit' },
);
console.log(
  `seeded ${remote ? 'remote' : 'local'} D1${adminOnly ? ' (admin account only)' : ''} (re-running skips what already exists)`,
);
