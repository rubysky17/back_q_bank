import { Role } from '../../generated/prisma/client.js';
import { AppError } from '../errors/app-error.js';
import type { AuthUser } from '../types/auth-user.js';

export const isAdmin = (user: AuthUser) => user.role === Role.ADMIN;

/** Prisma `where` fragment: hosts only see their own records, admins see everything. */
export const ownedBy = (user: AuthUser) =>
  isAdmin(user) ? {} : { ownerId: user.id };

/**
 * Throws 404 (not 403) when a host touches another host's private record,
 * so record ids of other hosts cannot be probed.
 */
export function assertOwner<T extends { ownerId: string }>(
  record: T | null,
  user: AuthUser,
  resource: string,
): T {
  if (!record || (!isAdmin(user) && record.ownerId !== user.id)) {
    throw AppError.notFound(resource);
  }
  return record;
}
