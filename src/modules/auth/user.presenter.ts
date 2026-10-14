import type { Prisma } from '../../generated/prisma/client.js';

export const userResponseSelect = {
  id: true,
  email: true,
  fullName: true,
  role: true,
  isActive: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

export type UserResponse = Prisma.UserGetPayload<{
  select: typeof userResponseSelect;
}>;

export function toUserResponse(user: UserResponse): UserResponse {
  const { id, email, fullName, role, isActive, createdAt } = user;
  return { id, email, fullName, role, isActive, createdAt };
}
