# Q Bank API — agent & contributor guide

NestJS 12 (ESM) + Prisma 7 + PostgreSQL 18 backend for a question-bank / exam app. Companion mobile app: `../client_q_bank` (Expo).

## Versions are pinned on purpose — check before upgrading

- **Prisma stays on 7.x.** `prisma@latest` is the Prisma 8 RC, which drops `schema.prisma` and `migrate dev`. Use the v7 docs: https://www.prisma.io/docs/guides/v7/frameworks/nestjs
- **TypeScript stays on 6.x.** TS 7 (the Go port) breaks `@nestjs/cli` and the Swagger plugin.
- **Prisma 7 specifics:**
  - The client is generated to `src/generated/prisma` and imported from `…/generated/prisma/client.js`.
  - It uses the `@prisma/adapter-pg` driver adapter.
  - The DB URL lives in `prisma.config.ts`, not in `schema.prisma`.
  - `migrate dev` no longer runs `generate` or `seed`.
- **ESM:** relative imports need the `.js` suffix (`./foo.service.js`).

## Commands

```bash
npm run db:up         # Postgres in Docker (localhost:5433, databases qbank + qbank_test)
npm run db:migrate    # after editing prisma/schema.prisma: creates + applies a migration, regenerates the client
npm run db:seed       # idempotent seed (admin, demo host/user, PMP sample exam)
npm run start:dev     # http://localhost:3000/api/v1, Swagger at /api/v1/docs
npm run check         # typecheck + lint + unit tests — run before declaring work done
npm run test:e2e      # e2e against qbank_test (needs db:up)
```

Never run `prisma migrate reset` or truncate tables on the dev database. The e2e helpers refuse to truncate a database whose name doesn't end in `_test`.

## Layout

- `src/modules/<feature>/`: one module per feature, each with `*.controller.ts`, `*.service.ts` and `dto/`. Features: auth, admin, topics, questions, exams, catalog, attempts.
- `src/modules/questions/question-types/`: one handler per question type. Register new ones in `index.ts`; no migration needed.
- `src/common/`:
  - `errors/`: `AppError` and validation formatting.
  - `filters/`: the global error filter.
  - `guards/`: `JwtAuthGuard` and `RolesGuard`, both global.
  - `decorators/`: `@Public`, `@Roles`, `@CurrentUser`.
  - `dto/`: pagination.
  - `utils/`: ownership helpers, slugify, shuffle.
- `src/app.setup.ts`: global prefix, pipes, filter, helmet, CORS and Swagger. It is shared by `main.ts` and the e2e tests.
- `prisma/schema.prisma`, `prisma/migrations/`, `prisma/seed.ts`.
- `test/*.e2e-spec.ts`: e2e tests (supertest). `test/helpers.ts` builds the app and signs users in.

## Rules

- **Errors:**
  - Throw `AppError.badRequest|unauthorized|forbidden|notFound|conflict(code, message, details?)` with a stable UPPER_SNAKE `code`.
  - `message` must be one human-readable string; the mobile client shows it as is.
  - Never return 401 for anything except authentication. The client signs out on 401, so use 400 for a wrong current password.
- **Auth:**
  - Every route requires a token unless it has `@Public()`.
  - Restrict routes with `@Roles(Role.HOST, Role.ADMIN)`.
  - Read the signed-in user with `@CurrentUser() user: AuthUser`; its role comes from the database on every request.
- **Ownership:**
  - Use `ownedBy(user)` in `where` and `assertOwner(record, user, 'Thing')`.
  - Another host's private record returns 404, never 403.
  - Topics and domains are shared: only their creator or an admin may change them.
- **Exams:**
  - Structure and settings change only in `DRAFT`, enforced by `ExamsService.findEditable`.
  - Added questions must share the exam's owner and topic.
- **Attempts:**
  - Questions are frozen into `AttemptQuestion.snapshot` when an attempt starts.
  - Never read live `Question` data when grading or reviewing.
  - State changes go through the row-locked `finalize` / answer transaction.
- **Validation:** request DTOs use class-validator. Type-specific JSON (question `definition`, answer `response`) is validated by the question type handler with zod.
- **Data:** points and scores are `Int`. IDs are UUIDv7. Timestamps are `timestamptz`.
- **Tests:**
  - Unit tests sit next to the file (`foo.spec.ts`).
  - Cover new endpoints in `test/*.e2e-spec.ts`, including the authorization cases.
