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
npm run db:seed       # idempotent seed (ADMIN account from ADMIN_EMAIL/ADMIN_PASSWORD + PMP sample exam)
npm run db:admin      # only create the admin / reset its password (db:admin:remote for production)
npm run check         # typecheck + lint + unit tests — run before declaring work done
npm run test:e2e      # e2e on a fresh in-memory local D1 per file
npm run cf:types      # after editing wrangler.jsonc
```

## Layout

- `src/index.ts`: the Worker entry. `src/app.ts` contains `createApp()`, with middleware, routes and the error handler.
- `src/env.ts`: vars and secrets validated with zod, plus the Hono `AppEnv` type.
- `src/db/schema.ts`: the schema and the source of truth for migrations. `src/db/client.ts`: `getDb()` and `batch()`. `src/db/errors.ts`: detects unique and foreign-key violations from D1 messages.
- `src/auth/`: register/login, password hashing (`password.ts`), sessions, refresh-token rotation, and the `requireAuth`, `requireRole` and `authRateLimit` middleware.
- `src/modules/<feature>/`: each has `routes.ts` (Hono) and `service.ts` (plain functions taking `(db, user, input)` plus their zod schemas). Features are topics, questions, exams (and `structure.ts`), catalog, attempts and vocab.
- `src/modules/vocab/`: offline-first vocabulary notes (`POST /vocab/sync`) translated through the free key-less endpoints of the browsers' translators (`translator.ts`: Google `translate_a/t` in three variants, Microsoft Edge as fallback; same approach as `~/Source/translator_extension`). They are unofficial: variants that refuse cool down and the next one is tried. `term.ts` is the SAME FILE as `src/vocab/term.ts` in both apps (`termKey` must match everywhere): change the three together, with their tests.
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
- **Auth:**
  - Accounts live in `User` with a PBKDF2 `passwordHash` (`src/auth/password.ts`). `POST /auth/register` always creates a `USER`; admins come from the seed script, hosts are promoted in the database.
  - Password hashing is the most expensive thing a request does (~0.24 ms CPU per 1,000 iterations). At most one hash per request: only register, login, `POST /auth/reauth` (checks the password, returns a 5-minute `reauthToken`) and `POST /auth/change-password` (hashes the new one) hash. Other sensitive changes (`DELETE /auth/me`) take a `reauthToken` instead of the password. `PASSWORD_HASH_ITERATIONS` defaults to 25,000 for the Free plan.
  - The Worker never reads `ADMIN_EMAIL` / `ADMIN_PASSWORD`; only `scripts/seed.ts` does.
  - Protect routes with `requireAuth` and restrict them with `requireRole('HOST', 'ADMIN')`.
  - Read the user from `c.var.user`; its role comes from the database on every request.
- **Ownership:**
  - Use `ownedBy(table.ownerId, user)` in `where` and `assertOwner(record, user, 'Thing')`.
  - Another host's private record returns 404, never 403.
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
- **Vocabulary:**
  - A note is `(userId, termKey)`. Deletes are tombstones; every write sets `rev = max(rev) + 1` inside SQL (the pull cursor is `(rev, termKey)`), including writes that lose last-write-wins, so the app always gets the winning state back.
  - `batch()` returns the raw D1 results: rows are keyed by SQL column name, with timestamps as ms numbers.
  - Translation: `Translator` (`translator.ts`) never throws. No answer from any engine (blocked, HTTP error, timeout) is `unavailable` and not counted; an empty translation counts toward the 3 tries. The vocab e2e spec stubs `fetch` for the Google and Microsoft URLs only (D1 must keep the real fetch); never let a test reach the real endpoints.
- **Attempts:**
  - Questions are frozen into `AttemptQuestion.snapshot` when an attempt starts. Never read live `Question` data when grading or reviewing.
  - Closing an attempt (`finalize`) is a conditional update; grading runs after it and is idempotent. A closed attempt with `score = null` is graded by the next read.
  - SECTIONED attempts (every section has `durationMinutes`) have no server deadline: the app keeps the section clocks, works offline and uploads events + state with `POST /attempts/:id/sync` (`attempts/sync.ts`). `PATCH /answers` is LEGACY only. ABANDONED attempts are graded but never pass or fail.
- **Migrations that rebuild a parent table:** `DROP TABLE` fires FK actions (`ON DELETE CASCADE`) even with `defer_foreign_keys`, so drizzle-kit's generated rebuild silently empties the child tables. Copy the children aside and drop them first (see `drizzle/0002_sectioned_attempts.sql`), and check that the generated `INSERT … SELECT` only reads columns that already exist.
- **Data:** points and scores are integers, ids are UUIDv7 strings, and timestamps are Unix milliseconds (`Date` in code).
- **Tests:**
  - Unit tests sit next to the file (`foo.spec.ts`).
  - Cover new endpoints in `test/*.e2e-spec.ts`, including the authorization cases. Use `signInAs(ctx, Role.HOST)` to create extra users directly in the database, `signInAsAdmin(ctx)` / `createAccount(ctx, …)` when the test needs a real password.
