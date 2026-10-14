import { Injectable } from '@nestjs/common';

import { paginated, toSkipTake } from '../../common/dto/pagination.dto.js';
import { AppError } from '../../common/errors/app-error.js';
import type { AuthUser } from '../../common/types/auth-user.js';
import { type Prisma, Role } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SessionsService } from '../auth/sessions.service.js';
import { userResponseSelect } from '../auth/user.presenter.js';
import type {
  ListUsersQueryDto,
  UpdateUserRoleDto,
  UpdateUserStatusDto,
} from './dto/admin.dto.js';

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
  ) {}

  async listUsers(query: ListUsersQueryDto) {
    const where: Prisma.UserWhereInput = {
      role: query.role,
      ...(query.q
        ? {
            OR: [
              { email: { contains: query.q, mode: 'insensitive' } },
              { fullName: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: userResponseSelect,
        orderBy: { createdAt: 'desc' },
        ...toSkipTake(query),
      }),
      this.prisma.user.count({ where }),
    ]);
    return paginated(items, total, query);
  }

  /** Takes effect on the user's very next request (the auth guard reads the role from the database). */
  async updateRole(admin: AuthUser, userId: string, dto: UpdateUserRoleDto) {
    await this.findManageableUser(admin, userId);
    return this.prisma.user.update({
      where: { id: userId },
      data: { role: dto.role },
      select: userResponseSelect,
    });
  }

  /** Disabling an account also signs it out everywhere. */
  async updateStatus(
    admin: AuthUser,
    userId: string,
    dto: UpdateUserStatusDto,
  ) {
    await this.findManageableUser(admin, userId);
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { isActive: dto.isActive },
      select: userResponseSelect,
    });
    if (!dto.isActive) await this.sessions.revokeAllForUser(userId);
    return user;
  }

  private async findManageableUser(admin: AuthUser, userId: string) {
    if (userId === admin.id) {
      throw AppError.badRequest(
        'CANNOT_MODIFY_SELF',
        'You cannot change your own account here',
      );
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    if (!user) throw AppError.notFound('User');
    if (user.role === Role.ADMIN) {
      throw AppError.forbidden('Admin accounts cannot be modified');
    }
  }
}
