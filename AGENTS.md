# Q Bank API — agent & contributor guide

Question-bank / exam API on **Cloudflare Workers (Free plan)**: Hono 4 + Drizzle ORM 0.45 + Cloudflare D1 (SQLite). Companion mobile app: `../client_q_bank` (Expo).

## The CPU budget comes first

The Free plan allows **10 ms of CPU per request** (time spent waiting on D1 does not count). Reads typically take 3–6.5 ms, measured in local workerd.
- **D1 results are decoded in JavaScript by the runtime**, so CPU grows with the number of queries and the number of rows/bytes returned. Select only the columns you need. For snapshots, read single JSON fields (`snapshot ->> '$.data'`) instead of whole documents.
- **Don't read back what you just wrote.** Build the response from memory (see `startAttempt`, `publishExam`).
- **No Prisma, no argon2, no heavy libraries.** They were removed because of the CPU budget.

## Versions are pinned on purpose

- **drizzle-orm 0.45 / drizzle-kit 0.31.** The 1.0 line changes the migrations format.
- **drizzle-orm 0.45's D1 `db.batch()` cannot bind raw SQL with parameters.** Use `batch()` from `src/db/client.ts` whenever a batch contains `db.run(sql`…`)`.

## Commands

```bash
npm run dev           # wrangler dev on http://localhost:8787/api/v1 (local D1 in .wrangler/, secrets from .env)
npm run db:generate   # after editing src/db/schema.ts: writes drizzle/NNNN_*.sql
npm run db:migrate    # apply migrations to local D1 (db:migrate:remote for production)
npm run db:seed       # idempotent seed (the configured account + PMP sample exam)
npm run check         # typecheck + lint + unit tests — run before declaring work done
npm run test:e2e      # e2e on a fresh in-memory local D1 per file
npm run cf:types      # after editing wrangler.jsonc
```

## Layout

- `src/index.ts`: the Worker entry. `src/app.ts` contains `createApp()`, with middleware, routes and the error handler.
- `src/env.ts`: vars and secrets validated with zod, plus the Hono `AppEnv` type.
- `src/db/schema.ts`: the schema and the source of truth for migrations. `src/db/client.ts`: `getDb()` and `batch()`. `src/db/errors.ts`: detects unique and foreign-key violations from D1 messages.
- `src/auth/`: single-account login, sessions, refresh-token rotation, and the `requireAuth`, `requireRole` and `authRateLimit` middleware.
- `src/modules/<feature>/`: each has `routes.ts` (Hono) and `service.ts` (plain functions taking `(db, user, input)` plus their zod schemas). Features are topics, questions, exams (and `structure.ts`), catalog and attempts.
- `src/modules/questions/question-types/`: one handler per question type. Register new ones in `index.ts`.
- `src/lib/`:
  - `app-error.ts`, `validation.ts`: `parseBody`, `parseQuery` and `idParam`, which produce `VALIDATION_ERROR`.
  - `access.ts`: `ownedBy`, `assertOwner`.
  - `sql.ts`: `inList`, `matchesSearch`, `qualified`, `countAll`.
  - `slugify.ts`: `slugify`, `searchKey`.
  - `uuidv7.ts`, `random.ts`, `pagination.ts`.
- `drizzle/`: generated migrations (`wrangler d1 migrations apply` runs the `.sql` files). `scripts/seed.ts` is the seed.
- `test/*.e2e-spec.ts`: e2e tests. `test/helpers.ts` starts local D1 through wrangler's `getPlatformProxy()`, applies the migrations, and exposes a supertest-like `ctx.api`.

## Rules

- **Errors:**
  - Throw `AppError.badRequest|unauthorized|forbidden|notFound|conflict(code, message, details?)` with a stable UPPER_SNAKE `code`.
  - `message` must be one human-readable string; the mobile client shows it as is.
  - Never return 401 for anything except authentication. The client signs out on 401.
- **Validation:**
  - Request bodies and queries use zod `strictObject` schemas through `parseBody` / `parseQuery`.
  - Use `zId()` for ids and `.nullish()` only for nullable columns.
  - Path ids go through `idParam(c, name)`.
- **Auth (single-account mode):**
  - Only `ADMIN_EMAIL` / `ADMIN_PASSWORD` can sign in. The account is upserted as ADMIN on login.
  - Protect routes with `requireAuth` and restrict them with `requireRole('HOST', 'ADMIN')`.
  - Read the user from `c.var.user`; its role comes from the database on every request.
- **Ownership:**
  - Use `ownedBy(table.ownerId, user)` in `where` and `assertOwner(record, user, 'Thing')`.
  - Another host's private record returns 404, never 403. Keep these checks even though only one account exists today.
- **D1 specifics:**
  - **No interactive transactions.** Writes that must succeed together go in one `db.batch()` / `batch()`, with ids generated up front (`uuidv7()`).
  - **State changes are conditional updates.** Use `UPDATE … WHERE status = 'X' RETURNING` (or check `meta.changes`) instead of locks. See `finalize` and `saveAnswers` in `attempts/service.ts`.
  - **At most 100 bound parameters per statement.** Lists of ids go through `inList()`. Bulk inserts and updates pass one JSON parameter and read it with `json_each` (see `addQuestions`, `reorderSections`, `startAttempt`).
  - **SQL dialect.** There are no `::` casts, and `lower()` / `LIKE` are ASCII-only. Search uses the `searchText` columns, which hold `searchKey()` of the source text: keep them in sync on every insert and update. Compare non-ASCII names in JS.
  - **Correlated subqueries.** Wrap the outer column in `qualified()`; Drizzle drops table names in single-table selects.
  - Every builder update sets `updatedAt` automatically; raw SQL updates must set it themselves.
- **Exams:**
  - Structure and settings change only in `DRAFT`, enforced by `findEditableExam`.
  - Added questions must share the exam's owner and topic.
- **Attempts:**
  - Questions are frozen into `AttemptQuestion.snapshot` when an attempt starts. Never read live `Question` data when grading or reviewing.
  - Closing an attempt (`finalize`) is a conditional update; grading runs after it and is idempotent. A closed attempt with `score = null` is graded by the next read.
- **Data:** points and scores are integers, ids are UUIDv7 strings, and timestamps are Unix milliseconds (`Date` in code).
- **Tests:**
  - Unit tests sit next to the file (`foo.spec.ts`).
  - Cover new endpoints in `test/*.e2e-spec.ts`, including the authorization cases. Use `signInAs(ctx, Role.HOST)` to create extra users directly in the database.
