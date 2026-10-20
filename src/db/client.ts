import type { Query } from 'drizzle-orm';
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';

export type Db = DrizzleD1Database & { $client: D1Database };

const cache = new WeakMap<D1Database, Db>();

/**
 * Drizzle over the D1 binding. D1 has no connections to open or close, so one instance per binding
 * object is reused across requests.
 *
 * D1 has no interactive transactions: group writes that must succeed together with `db.batch()`
 * (or `batch()` below when raw SQL is involved), and guard state changes with conditional updates
 * (`UPDATE … WHERE status = … RETURNING`).
 */
export function getDb(binding: D1Database): Db {
  let db = cache.get(binding);
  if (!db) {
    db = drizzle(binding);
    cache.set(binding, db);
  }
  return db;
}

type Statement = { toSQL(): Query } | { getQuery(): Query };

/**
 * Runs statements atomically in one D1 batch. Unlike `db.batch()`, it accepts raw SQL with
 * parameters (`db.run(sql`…`)`), which drizzle-orm 0.45's D1 batch cannot bind.
 *
 * Returns one raw D1 result per statement: rows of a SELECT (or `RETURNING`) are keyed by SQL
 * column name, with timestamps as Unix ms and booleans as 0/1 (no Drizzle mapping).
 */
export async function batch(
  db: Db,
  statements: Statement[],
): Promise<D1Result[]> {
  const client = db.$client;
  return client.batch(
    statements.map((statement) => {
      const { sql, params } =
        'getQuery' in statement ? statement.getQuery() : statement.toSQL();
      return client.prepare(sql).bind(...params);
    }),
  );
}
