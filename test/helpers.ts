import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { getPlatformProxy } from 'wrangler';

import { API_PREFIX, createApp } from '../src/app';
import { hashPassword } from '../src/auth/password';
import { createSession } from '../src/auth/sessions';
import { type Db, getDb } from '../src/db/client';
import { type Role as RoleName, users } from '../src/db/schema';
import { type Config, loadConfig } from '../src/env';

/** Role names as values, e.g. `signInAs(ctx, Role.HOST)`. */
export const Role = { USER: 'USER', HOST: 'HOST', ADMIN: 'ADMIN' } as const;

export interface TestResponse {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  headers: Headers;
}

export interface TestContext {
  /** The app itself, for requests outside /api/v1. */
  app: ReturnType<typeof createApp>;
  db: Db;
  config: Config;
  env: Env;
  api: Api;
  /** Same database, different vars/bindings (e.g. a rate limiter that always refuses). */
  apiWith(overrides: Record<string, unknown>): Api;
  close(): Promise<void>;
}

/** Runs drizzle/*.sql in order, like `wrangler d1 migrations apply`. */
async function applyMigrations(d1: D1Database) {
  const files = readdirSync('drizzle')
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const statements = readFileSync(`drizzle/${file}`, 'utf8')
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .filter(Boolean);
    await d1.batch(statements.map((statement) => d1.prepare(statement)));
  }
}

/** The Worker's bindings: a fresh in-memory local D1 plus the vars from .env.test (no rate limiter). */
function testEnv(d1: D1Database, overrides: Record<string, unknown> = {}): Env {
  return {
    DB: d1,
    JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET,
    JWT_ACCESS_TTL_SECONDS: process.env.JWT_ACCESS_TTL_SECONDS,
    REFRESH_TTL_DAYS: process.env.REFRESH_TTL_DAYS,
    PASSWORD_HASH_ITERATIONS: process.env.PASSWORD_HASH_ITERATIONS,
    CORS_ORIGINS: process.env.CORS_ORIGINS ?? '',
    ...overrides,
  } as unknown as Env;
}

/** Starts local D1 (workerd via wrangler's platform proxy) with every migration applied. */
export async function createTestContext(): Promise<TestContext> {
  const proxy = await getPlatformProxy<Env>({
    configPath: './wrangler.jsonc',
    persist: false,
  });
  await applyMigrations(proxy.env.DB);
  const env = testEnv(proxy.env.DB);
  return {
    app: createApp(),
    db: getDb(proxy.env.DB),
    config: loadConfig(env),
    env,
    api: createApi(env),
    apiWith: (overrides) => createApi(testEnv(proxy.env.DB, overrides)),
    close: () => proxy.dispose(),
  };
}

/** Request builder with a supertest-like surface: `await api.post(path, token).send(body).expect(201)`. */
class TestRequest implements PromiseLike<TestResponse> {
  private payload: unknown;
  private rawBody: string | undefined;
  private expected: number | undefined;

  constructor(
    private readonly app: ReturnType<typeof createApp>,
    private readonly env: Env,
    private readonly method: string,
    private readonly path: string,
    private readonly token?: string,
  ) {}

  send(body: unknown) {
    this.payload = body;
    return this;
  }

  /** Sends a body as-is (for malformed-JSON tests). */
  raw(body: string) {
    this.rawBody = body;
    return this;
  }

  expect(status: number) {
    this.expected = status;
    return this;
  }

  // Thenable on purpose: `await api.get(...).expect(200)` reads like supertest.
  // oxlint-disable-next-line unicorn/no-thenable
  then<A = TestResponse, B = never>(
    onFulfilled?: ((value: TestResponse) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return this.run().then(onFulfilled, onRejected);
  }

  private async run(): Promise<TestResponse> {
    const headers: Record<string, string> = {};
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    let body: string | undefined;
    if (this.rawBody !== undefined) body = this.rawBody;
    else if (this.payload !== undefined) body = JSON.stringify(this.payload);
    if (body !== undefined) headers['content-type'] = 'application/json';

    const res = await this.app.request(
      `${API_PREFIX}${this.path}`,
      { method: this.method.toUpperCase(), headers, body },
      this.env,
    );
    const text = await res.text();
    const response: TestResponse = {
      status: res.status,
      body: text ? JSON.parse(text) : {},
      headers: res.headers,
    };
    if (this.expected !== undefined && res.status !== this.expected) {
      throw new Error(
        `Expected ${this.expected}, got ${res.status} for ${this.method.toUpperCase()} ${this.path}: ${text}`,
      );
    }
    return response;
  }
}

type Api = ReturnType<typeof createApi>;

function createApi(env: Env) {
  const app = createApp();
  const call =
    (method: 'get' | 'post' | 'patch' | 'put' | 'delete') =>
    (path: string, token?: string) =>
      new TestRequest(app, env, method, path, token);
  return {
    get: call('get'),
    post: call('post'),
    patch: call('patch'),
    put: call('put'),
    delete: call('delete'),
  };
}

/** Empties every table (children first, so foreign keys never block). */
export async function resetDatabase(db: Db) {
  const tables = [
    'VocabNote',
    'TermTranslation',
    'AttemptEvent',
    'AttemptSection',
    'AttemptQuestion',
    'Attempt',
    'ExamQuestion',
    'ExamSection',
    'Exam',
    'Question',
    'CaseStudy',
    'Domain',
    'Topic',
    'Session',
    'User',
  ];
  await db.batch(
    tables.map((table) => db.run(sql.raw(`DELETE FROM "${table}"`))) as [
      ReturnType<Db['run']>,
      ...ReturnType<Db['run']>[],
    ],
  );
}

export interface SignedIn {
  id: string;
  email: string;
  token: string;
  refreshToken: string;
}

/** The admin account `signInAsAdmin` creates, as the seed script would. */
export const ADMIN = {
  email: 'admin@qbank.test',
  password: 'Admin-Passw0rd-123',
  fullName: 'Test Admin',
} as const;

/** Inserts a user with a real password hash (like the seed script), so it can sign in through the API. */
export async function createAccount(
  ctx: TestContext,
  account: {
    email: string;
    password: string;
    fullName: string;
    role: RoleName;
  },
) {
  const passwordHash = await hashPassword(
    account.password,
    ctx.config.PASSWORD_HASH_ITERATIONS,
  );
  await ctx.db
    .insert(users)
    .values({ ...account, passwordHash })
    .onConflictDoNothing({ target: users.email });
}

/** Creates the admin account if needed, then signs in through the API. */
export async function signInAsAdmin(
  ctx: TestContext,
  device: Record<string, unknown> = {},
): Promise<SignedIn> {
  await createAccount(ctx, { ...ADMIN, role: 'ADMIN' });
  const res = await ctx.api
    .post('/auth/login')
    .send({ email: ADMIN.email, password: ADMIN.password, ...device })
    .expect(200);
  return {
    id: res.body.user.id,
    email: res.body.user.email,
    token: res.body.accessToken,
    refreshToken: res.body.refreshToken,
  };
}

/**
 * Creates another user with the given role directly in the database and opens a session for it
 * (no password: faster than going through /auth/login when a test only needs a token).
 */
export async function signInAs(
  ctx: TestContext,
  role: RoleName,
  label: string = role.toLowerCase(),
): Promise<SignedIn> {
  const email = `${label}-${randomUUID().slice(0, 8)}@test.local`;
  const [user] = await ctx.db
    .insert(users)
    .values({ email, fullName: `Test ${label}`, role, passwordHash: '!' })
    .returning({ id: users.id });
  const tokens = await createSession(ctx.db, ctx.config, user.id, {}, {});
  return {
    id: user.id,
    email,
    token: tokens.accessToken,
    refreshToken: tokens.refreshToken,
  };
}

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
