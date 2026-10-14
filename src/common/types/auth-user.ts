import type { Role } from '../../generated/prisma/client.js';

/** The signed-in user, attached to the request by JwtAuthGuard (role is always read from the database). */
export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  sessionId: string;
}
