import { type AnyColumn, eq, type SQL } from 'drizzle-orm';

import type { Role } from '../db/schema';
import { AppError } from './app-error';

/** The signed-in user, attached by the auth middleware (role is always read from the database). */
export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  sessionId: string;
}

export const isAdmin = (user: AuthUser) => user.role === 'ADMIN';

/** `where` fragment: hosts only see their own records, admins see everything. */
export const ownedBy = (
  ownerColumn: AnyColumn,
  user: AuthUser,
): SQL | undefined => (isAdmin(user) ? undefined : eq(ownerColumn, user.id));

/**
 * Throws 404 (not 403) when a host touches another host's private record,
 * so record ids of other hosts cannot be probed.
 */
export function assertOwner<T extends { ownerId: string }>(
  record: T | null | undefined,
  user: AuthUser,
  resource: string,
): T {
  if (!record || (!isAdmin(user) && record.ownerId !== user.id)) {
    throw AppError.notFound(resource);
  }
  return record;
}
