/**
 * Idempotent seed: `npx prisma db seed`.
 * - Admin account from SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD
 * - Demo host + user (skipped when NODE_ENV=production)
 * - Topic PMP with its 3 domains, 9 single-choice questions and a published 3-section mock exam
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { argon2id, hash } from 'argon2';
import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';

import {
  Difficulty,
  ExamStatus,
  PrismaClient,
  Role,
} from '../src/generated/prisma/client.js';

config({ quiet: true });

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: requireEnv('DATABASE_URL') }),
});

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required to seed the database`);
  return value;
}

async function upsertUser(
  email: string,
  password: string,
  fullName: string,
  role: Role,
) {
  return prisma.user.upsert({
    where: { email },
    update: { role },
    create: {
      email,
      fullName,
      role,
      passwordHash: await hash(password, { type: argon2id }),
    },
    select: { id: true, email: true },
  });
}

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
  difficulty: Difficulty;
  content: string;
  options: string[];
  correct: number;
  explanation: string;
}[] = [
  {
    domain: 'people',
    difficulty: Difficulty.MEDIUM,
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
    difficulty: Difficulty.EASY,
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
    difficulty: Difficulty.HARD,
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
    difficulty: Difficulty.MEDIUM,
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
    difficulty: Difficulty.EASY,
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
    difficulty: Difficulty.HARD,
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
    difficulty: Difficulty.MEDIUM,
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
    difficulty: Difficulty.EASY,
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
    difficulty: Difficulty.HARD,
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

async function main() {
  const admin = await upsertUser(
    requireEnv('SEED_ADMIN_EMAIL').toLowerCase(),
    requireEnv('SEED_ADMIN_PASSWORD'),
    'System Admin',
    Role.ADMIN,
  );
  console.log(`admin: ${admin.email}`);

  if (process.env.NODE_ENV === 'production') return;

  const host = await upsertUser(
    'host@qbank.local',
    'Host@123456',
    'Demo Host',
    Role.HOST,
  );
  const user = await upsertUser(
    'user@qbank.local',
    'User@123456',
    'Demo User',
    Role.USER,
  );
  console.log(
    `demo accounts: ${host.email} / Host@123456, ${user.email} / User@123456`,
  );

  const topic = await prisma.topic.upsert({
    where: { slug: 'pmp' },
    update: {},
    create: {
      name: 'PMP',
      slug: 'pmp',
      description: 'Project Management Professional certification (PMI).',
      createdById: admin.id,
    },
    select: { id: true },
  });

  const domainIds = {} as Record<DomainKey, string>;
  for (const [order, domain] of DOMAINS.entries()) {
    const row = await prisma.domain.upsert({
      where: { topicId_name: { topicId: topic.id, name: domain.name } },
      update: {},
      create: {
        topicId: topic.id,
        name: domain.name,
        description: domain.description,
        order,
        createdById: admin.id,
      },
      select: { id: true },
    });
    domainIds[domain.key] = row.id;
  }

  const existing = await prisma.exam.findFirst({
    where: { ownerId: host.id, title: EXAM_TITLE },
    select: { id: true },
  });
  if (existing) {
    console.log(`"${EXAM_TITLE}" already exists, skipping questions and exam`);
    return;
  }

  await prisma.$transaction(async (tx) => {
    const questionIds: string[] = [];
    for (const question of QUESTIONS) {
      const created = await tx.question.create({
        data: {
          ownerId: host.id,
          topicId: topic.id,
          domainId: domainIds[question.domain],
          difficulty: question.difficulty,
          content: question.content,
          explanation: question.explanation,
          definition: {
            options: question.options.map((content, index) => ({
              id: randomUUID(),
              content,
              isCorrect: index === question.correct,
            })),
          },
        },
        select: { id: true },
      });
      questionIds.push(created.id);
    }

    const exam = await tx.exam.create({
      data: {
        ownerId: host.id,
        topicId: topic.id,
        title: EXAM_TITLE,
        description:
          'Mini mock exam with the real PMP layout: 3 sections (the real exam has 60 questions per section). Each section mixes all three domains.',
        status: ExamStatus.PUBLISHED,
        publishedAt: new Date(),
        durationMinutes: 15,
        passingScore: 70,
        shuffleOptions: true,
        sections: {
          create: [1, 2, 3].map((order) => ({
            title: `Section ${order}`,
            order,
          })),
        },
      },
      select: { id: true, sections: { select: { id: true, order: true } } },
    });

    // Section n gets the n-th question of each domain (People, Process, Business Environment).
    await tx.examQuestion.createMany({
      data: exam.sections.flatMap((section) =>
        [0, 3, 6].map((offset, index) => ({
          examId: exam.id,
          sectionId: section.id,
          questionId: questionIds[offset + section.order - 1],
          order: index + 1,
        })),
      ),
    });
  });
  console.log(
    `created ${QUESTIONS.length} questions and published "${EXAM_TITLE}"`,
  );
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
