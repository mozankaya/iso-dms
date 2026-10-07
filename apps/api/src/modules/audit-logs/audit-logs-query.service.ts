import { Injectable, NotFoundException } from '@nestjs/common';
import type { AuditLogDocumentDto, AuditLogDto, PaginatedDto } from '@iso-dms/shared';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import type { AuditLogWhereInput } from '../../generated/prisma/models';
import { PrismaService } from '../../prisma/prisma.service';
import type { ListAuditLogsDto } from './dto/list-audit-logs.dto';

/** The organization calendar runs on Istanbul time, which has had no daylight saving time since 2016. */
const DAY_OFFSET = '+03:00';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Prisma passes "contains" to ILIKE unescaped: neutralise the LIKE wildcards. */
const escapeLike = (text: string) => text.replace(/[\\%_]/g, '\\$&');

/**
 * Reading side of the audit trail (PROJECT.md 6.6). Only QUALITY_MANAGER and ADMIN reach it (the controller
 * says so); nothing here writes, and the database refuses changes to existing entries anyway.
 */
@Injectable()
export class AuditLogsQueryService {
  constructor(private readonly prisma: PrismaService) {}

  list(user: AuthenticatedUser, query: ListAuditLogsDto): Promise<PaginatedDto<AuditLogDto>> {
    return this.find(user, query, []);
  }

  /** The history of one document: its own entries and those of all its revisions. */
  async listForDocument(user: AuthenticatedUser, documentId: string, query: ListAuditLogsDto): Promise<PaginatedDto<AuditLogDto>> {
    const document = await this.prisma.document.findFirst({
      where: { id: documentId, organizationId: user.organizationId },
      select: { id: true, revisions: { select: { id: true } } },
    });
    if (!document) throw new NotFoundException({ code: 'DOCUMENT_NOT_FOUND', message: 'Document not found' });

    return this.find(user, query, [
      {
        OR: [
          { entityType: 'Document', entityId: document.id },
          { entityType: 'Revision', entityId: { in: document.revisions.map((revision) => revision.id) } },
        ],
      },
    ]);
  }

  private async find(user: AuthenticatedUser, query: ListAuditLogsDto, scope: AuditLogWhereInput[]): Promise<PaginatedDto<AuditLogDto>> {
    const where: AuditLogWhereInput = {
      AND: [{ organizationId: user.organizationId }, ...scope, ...(await this.filters(user, query))],
    };

    const [total, rows] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        // The id breaks ties, so pages stay stable when several entries share a moment
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { user: { select: { id: true, fullName: true, email: true } } },
      }),
    ]);

    const documents = await this.resolveDocuments(user.organizationId, rows);
    const mayReadAddresses = user.role === 'ADMIN';
    return {
      items: rows.map((row) => ({
        id: row.id,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        createdAt: row.createdAt.toISOString(),
        user: row.user,
        document: documents.get(`${row.entityType}:${row.entityId}`) ?? null,
        metadata:
          row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
            ? (row.metadata as Record<string, unknown>)
            : null,
        ipAddress: mayReadAddresses ? row.ipAddress : null,
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  private async filters(user: AuthenticatedUser, query: ListAuditLogsDto): Promise<AuditLogWhereInput[]> {
    const filters: AuditLogWhereInput[] = [];
    if (query.action) filters.push({ action: query.action });
    if (query.entityType) filters.push({ entityType: query.entityType });
    if (query.userId) filters.push({ userId: query.userId });

    // Calendar days of the organization, both ends included
    if (query.from) filters.push({ createdAt: { gte: new Date(`${query.from}T00:00:00${DAY_OFFSET}`) } });
    if (query.to) filters.push({ createdAt: { lt: new Date(new Date(`${query.to}T00:00:00${DAY_OFFSET}`).getTime() + DAY_MS) } });

    if (query.search) {
      const term = escapeLike(query.search);
      const [documents, revisions, users] = await Promise.all([
        this.prisma.document.findMany({
          where: { organizationId: user.organizationId, code: { contains: term, mode: 'insensitive' } },
          select: { id: true },
        }),
        this.prisma.revision.findMany({
          where: { organizationId: user.organizationId, document: { code: { contains: term, mode: 'insensitive' } } },
          select: { id: true },
        }),
        this.prisma.user.findMany({
          where: {
            organizationId: user.organizationId,
            OR: [{ fullName: { contains: term, mode: 'insensitive' } }, { email: { contains: term, mode: 'insensitive' } }],
          },
          select: { id: true },
        }),
      ]);
      filters.push({
        OR: [
          { entityType: 'Document', entityId: { in: documents.map((document) => document.id) } },
          { entityType: 'Revision', entityId: { in: revisions.map((revision) => revision.id) } },
          { userId: { in: users.map((found) => found.id) } },
        ],
      });
    }
    return filters;
  }

  /** Looks up the documents the page's entries are about, keyed "Document:<id>" / "Revision:<id>". */
  private async resolveDocuments(
    organizationId: string,
    rows: { entityType: string; entityId: string }[],
  ): Promise<Map<string, AuditLogDocumentDto>> {
    const documentIds = [...new Set(rows.filter((row) => row.entityType === 'Document').map((row) => row.entityId))];
    const revisionIds = [...new Set(rows.filter((row) => row.entityType === 'Revision').map((row) => row.entityId))];

    const [documents, revisions] = await Promise.all([
      documentIds.length
        ? this.prisma.document.findMany({ where: { organizationId, id: { in: documentIds } }, select: { id: true, code: true, title: true } })
        : [],
      revisionIds.length
        ? this.prisma.revision.findMany({
            where: { organizationId, id: { in: revisionIds } },
            select: { id: true, revisionNo: true, document: { select: { id: true, code: true, title: true } } },
          })
        : [],
    ]);

    const resolved = new Map<string, AuditLogDocumentDto>();
    for (const document of documents) resolved.set(`Document:${document.id}`, { ...document, revisionNo: null });
    for (const revision of revisions) resolved.set(`Revision:${revision.id}`, { ...revision.document, revisionNo: revision.revisionNo });
    return resolved;
  }
}
