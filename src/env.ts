import { z } from 'zod';

import type { Db } from './db/client';
import type { AuthUser } from './lib/access';

const commaList = z.string().transform((value) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
);

/** Worker vars + secrets, validated once per isolate. */
export const configSchema = z.object({
  /** The single account allowed to sign in (single-account mode). */
  ADMIN_EMAIL: z.string().trim().toLowerCase().pipe(z.email()),
  ADMIN_PASSWORD: z
    .string()
    .min(12, 'ADMIN_PASSWORD must be at least 12 characters'),
  ADMIN_NAME: z.string().trim().min(1).default('Admin'),
  JWT_ACCESS_SECRET: z
    .string()
    .min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).default(900),
  REFRESH_TTL_DAYS: z.coerce.number().int().min(1).default(30),
  /** Comma-separated browser origins (native mobile apps don't need CORS). */
  CORS_ORIGINS: commaList.default([]),
});

export type Config = z.infer<typeof configSchema>;

const cache = new WeakMap<object, Config>();

/** Parses vars/secrets; a misconfiguration fails every request with a log line listing the bad keys. */
export function loadConfig(env: object): Config {
  const cached = cache.get(env);
  if (cached) return cached;
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  cache.set(env, result.data);
  return result.data;
}

export interface AppEnv {
  Bindings: Env;
  Variables: {
    config: Config;
    db: Db;
    user: AuthUser;
  };
}
