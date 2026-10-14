import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { argon2id, hash } from 'argon2';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from '../src/app.module.js';
import { API_PREFIX, configureApp } from '../src/app.setup.js';
import { Role } from '../src/generated/prisma/client.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

export const PASSWORD = 'Passw0rd!123';

export interface TestContext {
  app: INestApplication;
  prisma: PrismaService;
  api: ReturnType<typeof createApi>;
}

export async function createTestContext(): Promise<TestContext> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  return { app, prisma: app.get(PrismaService), api: createApi(app) };
}

/** Empties every table. Refuses to run unless connected to a database whose name ends in `_test`. */
export async function resetDatabase(prisma: PrismaService) {
  const [{ name }] = await prisma.$queryRaw<{ name: string }[]>`
    SELECT current_database() AS name`;
  if (!name.endsWith('_test')) {
    throw new Error(`Refusing to truncate non-test database "${name}"`);
  }
  await prisma.$executeRawUnsafe(
    'TRUNCATE "AttemptQuestion", "Attempt", "ExamQuestion", "ExamSection", "Exam", ' +
      '"Question", "Domain", "Topic", "Session", "User" CASCADE',
  );
}

/** supertest with the API prefix and an optional bearer token. */
function createApi(app: INestApplication) {
  const server = app.getHttpServer();
  const call =
    (method: 'get' | 'post' | 'patch' | 'put' | 'delete') =>
    (path: string, token?: string) => {
      const req = request(server)[method](`/${API_PREFIX}${path}`);
      return token ? req.set('Authorization', `Bearer ${token}`) : req;
    };
  return {
    get: call('get'),
    post: call('post'),
    patch: call('patch'),
    put: call('put'),
    delete: call('delete'),
  };
}

let password: Promise<string> | undefined;
const passwordHash = () => (password ??= hash(PASSWORD, { type: argon2id }));

export interface SignedIn {
  id: string;
  email: string;
  token: string;
  refreshToken: string;
}

/** Creates a user with the given role directly in the database, then signs in through the API. */
export async function signInAs(
  ctx: TestContext,
  role: Role,
  label: string = role.toLowerCase(),
): Promise<SignedIn> {
  const email = `${label}-${randomUUID().slice(0, 8)}@test.local`;
  const user = await ctx.prisma.user.create({
    data: {
      email,
      fullName: `Test ${label}`,
      role,
      passwordHash: await passwordHash(),
    },
  });
  const res = await ctx.api
    .post('/auth/login')
    .send({ email, password: PASSWORD })
    .expect(200);
  return {
    id: user.id,
    email,
    token: res.body.accessToken,
    refreshToken: res.body.refreshToken,
  };
}

export { Role };

/** Body of a valid single-choice question; option `correct` is the right one. */
export function singleChoice(
  topicId: string,
  content: string,
  extra: Record<string, unknown> = {},
  correct = 0,
) {
  return {
    topicId,
    content,
    explanation: `Because option ${correct} is right`,
    definition: {
      options: ['A', 'B', 'C', 'D'].map((letter, index) => ({
        content: `${content} — option ${letter}`,
        isCorrect: index === correct,
      })),
    },
    ...extra,
  };
}

/** Option id of the correct / an incorrect answer in a host-side question payload. */
export function optionIds(question: {
  definition: { options: { id: string; isCorrect: boolean }[] };
}) {
  const { options } = question.definition;
  return {
    correct: options.find((option) => option.isCorrect)!.id,
    wrong: options.find((option) => !option.isCorrect)!.id,
  };
}
