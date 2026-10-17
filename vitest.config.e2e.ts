import { config } from 'dotenv';
import { defineConfig } from 'vitest/config';

// The e2e suite runs the app in Node against a fresh in-memory local D1 per file (vars from .env.test).
const testEnv =
  config({ path: '.env.test', quiet: true, processEnv: {} }).parsed ?? {};

export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    env: testEnv,
    // Each file starts its own local D1 (a workerd process); one at a time keeps it light.
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
