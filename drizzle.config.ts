import { defineConfig } from 'drizzle-kit';

// drizzle-kit only generates migrations here; wrangler applies them to D1
// (`npm run db:migrate` locally, `npm run db:migrate:remote` in production).
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
