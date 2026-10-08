import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { AdminDepartmentDto, DepartmentDto } from '@iso-dms/shared';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { CreateDepartmentDto, UpdateDepartmentDto } from './dto/department.dto';

const ADMIN_SELECT = {
  id: true,
  name: true,
  code: true,
  isActive: true,
  createdAt: true,
  _count: { select: { users: true, documents: true } },
} satisfies Prisma.DepartmentSelect;

type AdminRow = Prisma.DepartmentGetPayload<{ select: typeof ADMIN_SELECT }>;

function toAdminDto(row: AdminRow): AdminDepartmentDto {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    isActive: row.isActive,
    userCount: row._count.users,
    documentCount: row._count.documents,
    createdAt: row.createdAt.toISOString(),
  };
}

const isUniqueViolation = (error: unknown) => (error as { code?: string }).code === 'P2002';

@Injectable()
export class DepartmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  /** The active departments, for the pickers every role uses. */
  findAll(organizationId: string): Promise<DepartmentDto[]> {
    return this.prisma.department.findMany({
      where: { organizationId, isActive: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, code: true },
    });
  }

  /** Every department, active or not, with what depends on it (the administration screen). */
  async overview(organizationId: string): Promise<AdminDepartmentDto[]> {
    const rows = await this.prisma.department.findMany({ where: { organizationId }, orderBy: [{ isActive: 'desc' }, { name: 'asc' }], select: ADMIN_SELECT });
    return rows.map(toAdminDto);
  }

  async create(user: AuthenticatedUser, dto: CreateDepartmentDto, ipAddress: string | null): Promise<AdminDepartmentDto> {
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        await this.assertNameFree(tx, user.organizationId, dto.name, null);
        const row = await tx.department.create({ data: { organizationId: user.organizationId, name: dto.name, code: dto.code }, select: ADMIN_SELECT });
        await this.auditLogs.log(
          {
            organizationId: user.organizationId,
            userId: user.id,
            action: 'DEPARTMENT_CREATED',
            entityType: 'Department',
            entityId: row.id,
            metadata: { code: row.code, name: row.name },
            ipAddress,
          },
          tx,
        );
        return row;
      });
      return toAdminDto(created);
    } catch (error) {
      // The unique key (organization, code) is the last word when two requests ask for the same code at once
      if (isUniqueViolation(error)) throw new ConflictException({ code: 'DEPARTMENT_CODE_TAKEN', message: 'The department code is in use' });
      throw error;
    }
  }

  async update(user: AuthenticatedUser, id: string, dto: UpdateDepartmentDto, ipAddress: string | null): Promise<AdminDepartmentDto> {
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Department" WHERE id = ${id} AND "organizationId" = ${user.organizationId} FOR UPDATE`;
      const current = await tx.department.findFirst({ where: { id, organizationId: user.organizationId }, select: ADMIN_SELECT });
      if (!current) throw new NotFoundException({ code: 'DEPARTMENT_NOT_FOUND', message: 'Department not found' });

      const changes: Record<string, { from: unknown; to: unknown }> = {};
      if (dto.name !== undefined && dto.name !== current.name) changes.name = { from: current.name, to: dto.name };
      if (dto.isActive !== undefined && dto.isActive !== current.isActive) changes.isActive = { from: current.isActive, to: dto.isActive };
      // Nothing to change is not an error, and not worth a record
      if (Object.keys(changes).length === 0) return current;

      if (changes.name) await this.assertNameFree(tx, user.organizationId, dto.name!, id);
      const row = await tx.department.update({ where: { id }, data: { name: dto.name, isActive: dto.isActive }, select: ADMIN_SELECT });
      await this.auditLogs.log(
        {
          organizationId: user.organizationId,
          userId: user.id,
          action: 'DEPARTMENT_UPDATED',
          entityType: 'Department',
          entityId: id,
          metadata: { code: current.code, changes: changes as unknown as Prisma.InputJsonObject },
          ipAddress,
        },
        tx,
      );
      return row;
    });
    return toAdminDto(updated);
  }

  /** Two departments with the same name would only confuse the people who pick one ("Ik" and "IK" are the same). */
  private async assertNameFree(tx: Prisma.TransactionClient, organizationId: string, name: string, exceptId: string | null): Promise<void> {
    const wanted = name.toLocaleLowerCase('tr-TR');
    const names = await tx.department.findMany({ where: { organizationId, ...(exceptId && { id: { not: exceptId } }) }, select: { name: true } });
    if (names.some((other) => other.name.toLocaleLowerCase('tr-TR') === wanted)) {
      throw new ConflictException({ code: 'DEPARTMENT_NAME_TAKEN', message: 'The department name is in use' });
    }
  }
}
