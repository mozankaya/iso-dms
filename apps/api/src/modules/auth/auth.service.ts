import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { parseDurationMs } from '../../common/utils/duration';
import type { AccessTokenPayload } from '../../common/types/authenticated-user';
import type { User } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';

export interface SessionUser {
  id: string;
  organizationId: string;
  departmentId: string | null;
  email: string;
  fullName: string;
  role: User['role'];
  mustChangePassword: boolean;
}

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: Date;
  user: SessionUser;
}

const INVALID_CREDENTIALS = { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' };
const INVALID_REFRESH_TOKEN = { code: 'INVALID_REFRESH_TOKEN', message: 'Invalid refresh token' };

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function toSessionUser(user: User): SessionUser {
  return {
    id: user.id,
    organizationId: user.organizationId,
    departmentId: user.departmentId,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
  };
}

@Injectable()
export class AuthService {
  // Verified against when the email is unknown so response time does not reveal valid accounts.
  private dummyHash: Promise<string> | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  async login(email: string, password: string, ipAddress: string | null): Promise<AuthResult> {
    const normalizedEmail = email.trim().toLowerCase();

    // Single organization in the first release (PROJECT.md 5.1); resolved on the server.
    const organization = await this.prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
    if (!organization) {
      await argon2.verify(await this.getDummyHash(), password);
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    const user = await this.prisma.user.findUnique({
      where: {
        organizationId_email: { organizationId: organization.id, email: normalizedEmail },
      },
    });

    if (!user) {
      await argon2.verify(await this.getDummyHash(), password);
      await this.auditLogs.log({
        organizationId: organization.id,
        action: 'USER_LOGIN_FAILED',
        entityType: 'User',
        entityId: 'unknown',
        metadata: { email: normalizedEmail, reason: 'UNKNOWN_USER' },
        ipAddress,
      });
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    const passwordMatches = await argon2.verify(user.passwordHash, password);
    if (!passwordMatches || !user.isActive) {
      await this.auditLogs.log({
        organizationId: user.organizationId,
        userId: user.id,
        action: 'USER_LOGIN_FAILED',
        entityType: 'User',
        entityId: user.id,
        metadata: { reason: passwordMatches ? 'INACTIVE_USER' : 'WRONG_PASSWORD' },
        ipAddress,
      });
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    const result = await this.issueTokens(user);
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await this.auditLogs.log({
      organizationId: user.organizationId,
      userId: user.id,
      action: 'USER_LOGIN',
      entityType: 'User',
      entityId: user.id,
      ipAddress,
    });
    return result;
  }

  async refresh(refreshToken: string | undefined, ipAddress: string | null): Promise<AuthResult> {
    if (!refreshToken) throw new UnauthorizedException(INVALID_REFRESH_TOKEN);

    try {
      await this.jwt.verifyAsync(refreshToken, {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedException(INVALID_REFRESH_TOKEN);
    }

    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(refreshToken) },
      include: { user: true },
    });
    if (!stored) throw new UnauthorizedException(INVALID_REFRESH_TOKEN);

    // Rotation: a token is valid exactly once. Reuse of a revoked token means it may have leaked.
    const revokedNow = stored.revokedAt
      ? 0
      : (
          await this.prisma.refreshToken.updateMany({
            where: { id: stored.id, revokedAt: null },
            data: { revokedAt: new Date() },
          })
        ).count;
    if (revokedNow === 0) {
      await this.revokeAllForUser(stored.organizationId, stored.userId);
      await this.auditLogs.log({
        organizationId: stored.organizationId,
        userId: stored.userId,
        action: 'REFRESH_TOKEN_REUSE_DETECTED',
        entityType: 'User',
        entityId: stored.userId,
        ipAddress,
      });
      throw new UnauthorizedException(INVALID_REFRESH_TOKEN);
    }

    if (stored.expiresAt <= new Date() || !stored.user.isActive) {
      throw new UnauthorizedException(INVALID_REFRESH_TOKEN);
    }

    return this.issueTokens(stored.user);
  }

  async logout(refreshToken: string | undefined, ipAddress: string | null): Promise<void> {
    if (!refreshToken) return;

    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(refreshToken) },
    });
    if (!stored) return;

    await this.prisma.refreshToken.updateMany({
      where: { id: stored.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.auditLogs.log({
      organizationId: stored.organizationId,
      userId: stored.userId,
      action: 'USER_LOGOUT',
      entityType: 'User',
      entityId: stored.userId,
      ipAddress,
    });
  }

  async me(userId: string, organizationId: string): Promise<SessionUser> {
    const user = await this.prisma.user.findFirst({ where: { id: userId, organizationId } });
    if (!user || !user.isActive) {
      throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'Authentication required' });
    }
    return toSessionUser(user);
  }

  /**
   * The user replaces their password (a temporary one, or any time). Every other session is closed: whoever
   * held the old password must not stay signed in. The answer is a fresh session, like a sign-in.
   */
  async changePassword(
    userId: string,
    organizationId: string,
    currentPassword: string,
    newPassword: string,
    ipAddress: string | null,
  ): Promise<AuthResult> {
    const user = await this.prisma.user.findFirst({ where: { id: userId, organizationId } });
    if (!user || !user.isActive) {
      throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'Authentication required' });
    }
    if (!(await argon2.verify(user.passwordHash, currentPassword))) {
      throw new BadRequestException({ code: 'CURRENT_PASSWORD_INCORRECT', message: 'The current password is not correct' });
    }
    if (currentPassword === newPassword) {
      throw new BadRequestException({ code: 'PASSWORD_UNCHANGED', message: 'The new password has to differ from the current one' });
    }

    const passwordHash = await argon2.hash(newPassword);
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.user.update({ where: { id: user.id }, data: { passwordHash, mustChangePassword: false } });
      await tx.refreshToken.updateMany({ where: { organizationId, userId, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.auditLogs.log(
        {
          organizationId,
          userId,
          action: 'USER_PASSWORD_CHANGED',
          entityType: 'User',
          entityId: userId,
          metadata: { wasTemporary: user.mustChangePassword },
          ipAddress,
        },
        tx,
      );
      return row;
    });
    return this.issueTokens(updated);
  }

  private async issueTokens(user: User): Promise<AuthResult> {
    const payload: AccessTokenPayload = {
      sub: user.id,
      organizationId: user.organizationId,
      role: user.role,
      departmentId: user.departmentId,
      ...(user.mustChangePassword && { mustChangePassword: true }),
    };
    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      expiresIn: this.config.get<string>('JWT_ACCESS_EXPIRES_IN', '15m') as never,
    });

    const refreshTtlMs = parseDurationMs(this.config.get<string>('JWT_REFRESH_EXPIRES_IN', '7d'));
    const refreshExpiresAt = new Date(Date.now() + refreshTtlMs);
    // jti makes every refresh token unique even when issued within the same second
    const refreshToken = await this.jwt.signAsync(
      { sub: user.id, jti: randomUUID() },
      {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
        expiresIn: Math.floor(refreshTtlMs / 1000),
      },
    );
    await this.prisma.refreshToken.create({
      data: {
        organizationId: user.organizationId,
        userId: user.id,
        tokenHash: hashToken(refreshToken),
        expiresAt: refreshExpiresAt,
      },
    });

    return { accessToken, refreshToken, refreshExpiresAt, user: toSessionUser(user) };
  }

  private async revokeAllForUser(organizationId: string, userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { organizationId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= argon2.hash(randomUUID());
    return this.dummyHash;
  }
}
