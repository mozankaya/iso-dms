import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { AdminCategoryDto, CategoryDto } from '@iso-dms/shared';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { CreateCategoryDto, UpdateCategoryDto } from './dto/category.dto';
import { slugify } from './slugify';

const ADMIN_SELECT = {
  id: true,
  name: true,
  slug: true,
  codePrefix: true,
  description: true,
  icon: true,
  sortOrder: true,
  defaultReviewIntervalMonths: true,
  isExternal: true,
  externalUrl: true,
  isActive: true,
  createdAt: true,
  _count: { select: { documents: true } },
} satisfies Prisma.CategorySelect;

type AdminRow = Prisma.CategoryGetPayload<{ select: typeof ADMIN_SELECT }>;

function toAdminDto(row: AdminRow): AdminCategoryDto {
  const { _count, createdAt, ...fields } = row;
  return { ...fields, documentCount: _count.documents, createdAt: createdAt.toISOString() };
}

const isUniqueViolation = (error: unknown) => (error as { code?: string }).code === 'P2002';
const sameName = (a: string, b: string) => a.toLocaleLowerCase('tr-TR') === b.toLocaleLowerCase('tr-TR');

@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  /** Active categories with the number of published documents in each. */
  async findAll(organizationId: string): Promise<CategoryDto[]> {
    const categories = await this.prisma.category.findMany({
      where: { organizationId, isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        _count: { select: { documents: { where: { organizationId, status: 'PUBLISHED' } } } },
      },
    });

    return categories.map((category) => ({
      id: category.id,
      name: category.name,
      slug: category.slug,
      codePrefix: category.codePrefix,
      description: category.description,
      icon: category.icon,
      sortOrder: category.sortOrder,
      isExternal: category.isExternal,
      externalUrl: category.externalUrl,
      documentCount: category._count.documents,
    }));
  }

  /** Every category, active or not, with the documents it holds in any state (the administration screen). */
  async overview(organizationId: string): Promise<AdminCategoryDto[]> {
    const rows = await this.prisma.category.findMany({
      where: { organizationId },
      orderBy: [{ isActive: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }],
      select: ADMIN_SELECT,
    });
    return rows.map(toAdminDto);
  }

  async create(user: AuthenticatedUser, dto: CreateCategoryDto, ipAddress: string | null): Promise<AdminCategoryDto> {
    const isExternal = dto.isExternal ?? false;
    if (dto.externalUrl && !isExternal) throw this.externalUrlNotAllowed();

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        // Creations of one organization take turns: the checks below and the free slug cannot be raced
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`category:${user.organizationId}`}, 0))`;
        const existing = await tx.category.findMany({
          where: { organizationId: user.organizationId },
          select: { name: true, slug: true, codePrefix: true, sortOrder: true },
        });
        if (existing.some((other) => sameName(other.name, dto.name))) {
          throw new ConflictException({ code: 'CATEGORY_NAME_TAKEN', message: 'The category name is in use' });
        }
        if (existing.some((other) => other.codePrefix === dto.codePrefix)) {
          throw new ConflictException({ code: 'CATEGORY_PREFIX_TAKEN', message: 'The category prefix is in use' });
        }

        const row = await tx.category.create({
          data: {
            organizationId: user.organizationId,
            name: dto.name,
            slug: freeSlug(dto.name, new Set(existing.map((other) => other.slug))),
            codePrefix: dto.codePrefix,
            description: dto.description ?? null,
            icon: dto.icon ?? null,
            sortOrder: dto.sortOrder ?? Math.max(0, ...existing.map((other) => other.sortOrder)) + 1,
            defaultReviewIntervalMonths: dto.defaultReviewIntervalMonths ?? null,
            isExternal,
            externalUrl: dto.externalUrl ?? null,
          },
          select: ADMIN_SELECT,
        });
        await this.auditLogs.log(
          {
            organizationId: user.organizationId,
            userId: user.id,
            action: 'CATEGORY_CREATED',
            entityType: 'Category',
            entityId: row.id,
            metadata: { codePrefix: row.codePrefix, name: row.name, slug: row.slug },
            ipAddress,
          },
          tx,
        );
        return row;
      });
      return toAdminDto(created);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException({ code: 'CATEGORY_PREFIX_TAKEN', message: 'The category prefix is in use' });
      throw error;
    }
  }

  async update(user: AuthenticatedUser, id: string, dto: UpdateCategoryDto, ipAddress: string | null): Promise<AdminCategoryDto> {
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Category" WHERE id = ${id} AND "organizationId" = ${user.organizationId} FOR UPDATE`;
      const current = await tx.category.findFirst({ where: { id, organizationId: user.organizationId }, select: ADMIN_SELECT });
      if (!current) throw new NotFoundException({ code: 'CATEGORY_NOT_FOUND', message: 'Category not found' });
      if (dto.externalUrl && !current.isExternal) throw this.externalUrlNotAllowed();

      const changes: Record<string, { from: unknown; to: unknown }> = {};
      const data: Prisma.CategoryUpdateInput = {};
      const change = <K extends keyof UpdateCategoryDto & keyof AdminRow>(key: K) => {
        const next = dto[key];
        if (next === undefined || next === current[key]) return;
        changes[key] = { from: current[key], to: next };
        (data as Record<string, unknown>)[key] = next;
      };
      (['name', 'description', 'icon', 'sortOrder', 'defaultReviewIntervalMonths', 'externalUrl', 'isActive'] as const).forEach(change);
      // Nothing to change is not an error, and not worth a record
      if (Object.keys(changes).length === 0) return current;

      if (changes.name) {
        const others = await tx.category.findMany({ where: { organizationId: user.organizationId, id: { not: id } }, select: { name: true } });
        if (others.some((other) => sameName(other.name, dto.name!))) {
          throw new ConflictException({ code: 'CATEGORY_NAME_TAKEN', message: 'The category name is in use' });
        }
      }

      const row = await tx.category.update({ where: { id }, data, select: ADMIN_SELECT });
      await this.auditLogs.log(
        {
          organizationId: user.organizationId,
          userId: user.id,
          action: 'CATEGORY_UPDATED',
          entityType: 'Category',
          entityId: id,
          metadata: { codePrefix: current.codePrefix, changes: changes as unknown as Prisma.InputJsonObject },
          ipAddress,
        },
        tx,
      );
      return row;
    });
    return toAdminDto(updated);
  }

  private externalUrlNotAllowed(): BadRequestException {
    return new BadRequestException({ code: 'EXTERNAL_URL_NOT_ALLOWED', message: 'Only an external category has a link' });
  }
}

/** The address of a new category: from its name, and numbered when another one has it already. */
function freeSlug(name: string, taken: Set<string>): string {
  const base = slugify(name) || 'category';
  if (!taken.has(base)) return base;
  for (let number = 2; ; number++) {
    const candidate = `${base}-${number}`;
    if (!taken.has(candidate)) return candidate;
  }
}
