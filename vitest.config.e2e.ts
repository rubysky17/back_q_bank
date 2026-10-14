import { config } from 'dotenv';
import { defineConfig } from 'vitest/config';

// The e2e suite always runs against the qbank_test database from .env.test.
const testEnv =
  config({ path: '.env.test', quiet: true, processEnv: {} }).parsed ?? {};

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    env: testEnv,
    globalSetup: ['./test/global-setup.ts'],
    // Files share one database; run them one after another.
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
