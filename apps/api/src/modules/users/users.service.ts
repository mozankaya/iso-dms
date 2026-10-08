import { randomInt } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DEPARTMENT_REQUIRED_ROLES, type AdminUserDto, type PaginatedDto, type UserWithPasswordDto } from '@iso-dms/shared';
import * as argon2 from 'argon2';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { CreateUserDto, ListUsersDto, ResetPasswordDto, UpdateUserDto } from './dto/user.dto';

const escapeLike = (text: string) => text.replace(/[\\%_]/g, '\\$&');

const USER_SELECT = {
  id: true,
  fullName: true,
  email: true,
  role: true,
  isActive: true,
  mustChangePassword: true,
  lastLoginAt: true,
  createdAt: true,
  department: { select: { id: true, name: true, code: true } },
} satisfies Prisma.UserSelect;

type UserRow = Prisma.UserGetPayload<{ select: typeof USER_SELECT }>;

function toDto(row: UserRow): AdminUserDto {
  return {
    id: row.id,
    fullName: row.fullName,
    email: row.email,
    role: row.role,
    department: row.department,
    isActive: row.isActive,
    mustChangePassword: row.mustChangePassword,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Without look-alike characters (0/O, 1/l/I), since an administrator reads it out to somebody. */
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const GENERATED_PASSWORD_LENGTH = 16;

function generatePassword(): string {
  return Array.from({ length: GENERATED_PASSWORD_LENGTH }, () => PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)]).join('');
}

const isUniqueViolation = (error: unknown) => (error as { code?: string }).code === 'P2002';
const emailTaken = () => new ConflictException({ code: 'EMAIL_TAKEN', message: 'The email is in use' });
const ownAccountProtected = () =>
  new ConflictException({ code: 'OWN_ACCOUNT_PROTECTED', message: 'Administrators cannot do this to their own account' });

/** Administration of the organization's users (PROJECT.md 6.10). Passwords never reach the audit trail. */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  async list(organizationId: string, query: ListUsersDto): Promise<PaginatedDto<AdminUserDto>> {
    const and: Prisma.UserWhereInput[] = [{ organizationId }];
    if (query.role) and.push({ role: query.role });
    if (query.departmentId) and.push({ departmentId: query.departmentId });
    if (query.status !== 'all') and.push({ isActive: query.status === 'active' });
    if (query.search) {
      const term = escapeLike(query.search);
      and.push({ OR: [{ fullName: { contains: term, mode: 'insensitive' } }, { email: { contains: term, mode: 'insensitive' } }] });
    }
    const where: Prisma.UserWhereInput = { AND: and };

    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: [{ isActive: 'desc' }, { fullName: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: USER_SELECT,
      }),
      this.prisma.user.count({ where }),
    ]);
    return { items: rows.map(toDto), total, page: query.page, pageSize: query.pageSize };
  }

  async create(actor: AuthenticatedUser, dto: CreateUserDto, ipAddress: string | null): Promise<UserWithPasswordDto> {
    const departmentId = dto.departmentId ?? null;
    this.assertDepartmentRule(dto.role, departmentId);
    const generated = dto.password === undefined;
    const password = dto.password ?? generatePassword();
    // Hashing is slow on purpose: done before the transaction so no lock is held meanwhile
    const passwordHash = await argon2.hash(password);

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        await this.lockUsers(tx, actor.organizationId);
        if (departmentId) await this.assertDepartment(tx, actor.organizationId, departmentId);
        const existing = await tx.user.findUnique({ where: { organizationId_email: { organizationId: actor.organizationId, email: dto.email } }, select: { id: true } });
        if (existing) throw emailTaken();

        const row = await tx.user.create({
          data: { organizationId: actor.organizationId, departmentId, email: dto.email, fullName: dto.fullName, passwordHash, role: dto.role, mustChangePassword: true },
          select: USER_SELECT,
        });
        await this.auditLogs.log(
          {
            organizationId: actor.organizationId,
            userId: actor.id,
            action: 'USER_CREATED',
            entityType: 'User',
            entityId: row.id,
            metadata: { email: row.email, fullName: row.fullName, role: row.role, departmentCode: row.department?.code ?? null, passwordGenerated: generated },
            ipAddress,
          },
          tx,
        );
        return row;
      });
      return { user: toDto(created), temporaryPassword: generated ? password : null };
    } catch (error) {
      if (isUniqueViolation(error)) throw emailTaken();
      throw error;
    }
  }

  async update(actor: AuthenticatedUser, id: string, dto: UpdateUserDto, ipAddress: string | null): Promise<AdminUserDto> {
    return this.prisma.$transaction(async (tx) => {
      // One at a time per organization: the "last administrator" check below cannot be raced
      await this.lockUsers(tx, actor.organizationId);
      const current = await tx.user.findFirst({ where: { id, organizationId: actor.organizationId }, select: USER_SELECT });
      if (!current) throw this.notFound();

      const nextRole = dto.role ?? current.role;
      const nextActive = dto.isActive ?? current.isActive;
      const nextDepartmentId = dto.departmentId === undefined ? (current.department?.id ?? null) : dto.departmentId;

      const roleChanges = nextRole !== current.role;
      const activeChanges = nextActive !== current.isActive;
      const departmentChanges = nextDepartmentId !== (current.department?.id ?? null);
      if (id === actor.id && (roleChanges || activeChanges)) throw ownAccountProtected();

      if (roleChanges || departmentChanges) this.assertDepartmentRule(nextRole, nextDepartmentId);
      if (departmentChanges && nextDepartmentId) await this.assertDepartment(tx, actor.organizationId, nextDepartmentId);

      if (current.role === 'ADMIN' && current.isActive && (nextRole !== 'ADMIN' || !nextActive)) {
        const others = await tx.user.count({ where: { organizationId: actor.organizationId, role: 'ADMIN', isActive: true, id: { not: id } } });
        if (others === 0) {
          throw new ConflictException({ code: 'LAST_ADMIN_PROTECTED', message: 'The last active administrator cannot be removed' });
        }
      }

      const changes: Record<string, { from: unknown; to: unknown }> = {};
      if (dto.fullName !== undefined && dto.fullName !== current.fullName) changes.fullName = { from: current.fullName, to: dto.fullName };
      if (roleChanges) changes.role = { from: current.role, to: nextRole };
      if (departmentChanges) changes.departmentId = { from: current.department?.id ?? null, to: nextDepartmentId };
      if (activeChanges) changes.isActive = { from: current.isActive, to: nextActive };
      // Nothing to change is not an error, and not worth a record
      if (Object.keys(changes).length === 0) return toDto(current);

      const row = await tx.user.update({
        where: { id },
        data: { fullName: dto.fullName, role: nextRole, departmentId: nextDepartmentId, isActive: nextActive },
        select: USER_SELECT,
      });
      // A deactivated user must not slip back in with a session that was open
      if (activeChanges && !nextActive) await this.revokeSessions(tx, actor.organizationId, id);
      await this.auditLogs.log(
        {
          organizationId: actor.organizationId,
          userId: actor.id,
          action: 'USER_UPDATED',
          entityType: 'User',
          entityId: id,
          metadata: { email: current.email, changes: changes as unknown as Prisma.InputJsonObject },
          ipAddress,
        },
        tx,
      );
      return toDto(row);
    });
  }

  async resetPassword(actor: AuthenticatedUser, id: string, dto: ResetPasswordDto, ipAddress: string | null): Promise<UserWithPasswordDto> {
    if (id === actor.id) throw ownAccountProtected();
    const generated = dto.password === undefined;
    const password = dto.password ?? generatePassword();
    const passwordHash = await argon2.hash(password);

    const row = await this.prisma.$transaction(async (tx) => {
      const current = await tx.user.findFirst({ where: { id, organizationId: actor.organizationId }, select: { id: true, email: true } });
      if (!current) throw this.notFound();

      const updated = await tx.user.update({ where: { id }, data: { passwordHash, mustChangePassword: true }, select: USER_SELECT });
      await this.revokeSessions(tx, actor.organizationId, id);
      await this.auditLogs.log(
        {
          organizationId: actor.organizationId,
          userId: actor.id,
          action: 'USER_PASSWORD_RESET',
          entityType: 'User',
          entityId: id,
          metadata: { email: current.email, passwordGenerated: generated },
          ipAddress,
        },
        tx,
      );
      return updated;
    });
    return { user: toDto(row), temporaryPassword: generated ? password : null };
  }

  private notFound(): NotFoundException {
    return new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found' });
  }

  private async lockUsers(tx: Prisma.TransactionClient, organizationId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`users:${organizationId}`}, 0))`;
  }

  private async revokeSessions(tx: Prisma.TransactionClient, organizationId: string, userId: string): Promise<void> {
    await tx.refreshToken.updateMany({ where: { organizationId, userId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  /** Editors and approvers work for a unit: without one they could do nothing (PROJECT.md 6.1.1, 6.2.1). */
  private assertDepartmentRule(role: string, departmentId: string | null): void {
    if (DEPARTMENT_REQUIRED_ROLES.includes(role as never) && !departmentId) {
      throw new BadRequestException({ code: 'DEPARTMENT_REQUIRED', message: 'This role needs a department' });
    }
  }

  private async assertDepartment(tx: Prisma.TransactionClient, organizationId: string, departmentId: string): Promise<void> {
    const department = await tx.department.findFirst({ where: { id: departmentId, organizationId, isActive: true }, select: { id: true } });
    if (!department) throw new NotFoundException({ code: 'DEPARTMENT_NOT_FOUND', message: 'Department not found' });
  }
}
