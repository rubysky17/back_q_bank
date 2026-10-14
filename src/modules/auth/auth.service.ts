import { HttpStatus, Injectable } from '@nestjs/common';

import { AppError } from '../../common/errors/app-error.js';
import type { AuthUser } from '../../common/types/auth-user.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type {
  ChangePasswordDto,
  LoginDto,
  RegisterDto,
} from './dto/auth.dto.js';
import { PasswordService } from './password.service.js';
import {
  type AuthTokens,
  type ClientMeta,
  SessionsService,
} from './sessions.service.js';
import {
  toUserResponse,
  type UserResponse,
  userResponseSelect,
} from './user.presenter.js';

export type AuthResult = AuthTokens & { user: UserResponse };

const invalidCredentials = () =>
  AppError.unauthorized(
    'INVALID_CREDENTIALS',
    'Email or password is incorrect',
  );

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionsService,
  ) {}

  /** Self-registration always creates a USER; an ADMIN promotes hosts. */
  async register(dto: RegisterDto, meta: ClientMeta): Promise<AuthResult> {
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
      select: { id: true },
    });
    if (existing) {
      throw AppError.conflict(
        'EMAIL_TAKEN',
        'An account with this email already exists',
      );
    }

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        fullName: dto.fullName,
        passwordHash: await this.passwords.hash(dto.password),
      },
      select: userResponseSelect,
    });
    const tokens = await this.sessions.create(user.id, dto, meta);
    return { user: toUserResponse(user), ...tokens };
  }

  async login(dto: LoginDto, meta: ClientMeta): Promise<AuthResult> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      select: { ...userResponseSelect, passwordHash: true },
    });
    if (!user) {
      await this.passwords.burnTime(dto.password);
      throw invalidCredentials();
    }
    if (!(await this.passwords.verify(user.passwordHash, dto.password))) {
      throw invalidCredentials();
    }
    if (!user.isActive) {
      throw new AppError(
        HttpStatus.FORBIDDEN,
        'ACCOUNT_DISABLED',
        'This account has been disabled',
      );
    }

    const tokens = await this.sessions.create(user.id, dto, meta);
    return { user: toUserResponse(user), ...tokens };
  }

  async refresh(refreshToken: string, meta: ClientMeta): Promise<AuthResult> {
    const { userId, tokens } = await this.sessions.rotate(refreshToken, meta);
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: userResponseSelect,
    });
    return { user: toUserResponse(user), ...tokens };
  }

  logout(user: AuthUser) {
    return this.sessions.revoke(user.sessionId);
  }

  async me(user: AuthUser): Promise<UserResponse> {
    return this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: userResponseSelect,
    });
  }

  /** Keeps the current device signed in and signs out every other device. */
  async changePassword(user: AuthUser, dto: ChangePasswordDto) {
    const { passwordHash } = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { passwordHash: true },
    });
    // 400, not 401: a 401 would make the mobile client drop the session.
    if (!(await this.passwords.verify(passwordHash, dto.currentPassword))) {
      throw AppError.badRequest(
        'WRONG_PASSWORD',
        'Current password is incorrect',
      );
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await this.passwords.hash(dto.newPassword) },
    });
    await this.sessions.revokeAllForUser(user.id, user.sessionId);
  }
}
