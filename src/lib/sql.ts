import { type AnyColumn, getTableName, sql, type SQL } from 'drizzle-orm';

import { searchKey } from './slugify';

/**
 * `"Table"."column"` always qualified. Use it for the outer column in correlated subqueries: Drizzle
 * renders columns unqualified in single-table selects, so `${table.id}` inside a subquery would
 * silently bind to the subquery's own table.
 */
export const qualified = (column: AnyColumn) =>
  sql.raw(`"${getTableName(column.table)}"."${column.name}"`);

/**
 * `column IN (…)` with the whole list as ONE bound parameter (D1 allows at most 100 per query).
 */
export const inList = (column: AnyColumn, values: readonly string[]): SQL =>
  sql`${column} IN (SELECT value FROM json_each(${JSON.stringify(values)}))`;

/** Case- and accent-insensitive "contains" against a `searchText` column (see searchKey). */
export const matchesSearch = (searchColumn: AnyColumn, text: string): SQL =>
  sql`instr(${searchColumn}, ${searchKey(text)}) > 0`;

export const countAll = () => sql<number>`count(*)`;
