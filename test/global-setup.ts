import { config } from 'dotenv';
import { execFileSync } from 'node:child_process';

/** Applies pending migrations to the test database (non-destructive); each spec file truncates its own data. */
export default function setup() {
  const testEnv =
    config({ path: '.env.test', quiet: true, processEnv: {} }).parsed ?? {};
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    stdio: 'inherit',
    env: { ...process.env, ...testEnv },
  });
}
