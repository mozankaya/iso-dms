import { Injectable } from '@nestjs/common';
import type { DocumentListItemDto, DocumentSortField, PaginatedDto, SortOrder } from '@iso-dms/shared';
import type { DocumentOrderByWithRelationInput, DocumentWhereInput } from '../../generated/prisma/models';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { PrismaService } from '../../prisma/prisma.service';
import type { ListDocumentsDto } from './dto/list-documents.dto';

@Injectable()
export class DocumentsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: AuthenticatedUser, query: ListDocumentsDto): Promise<PaginatedDto<DocumentListItemDto>> {
    const where = this.buildWhere(user, query);
    const orderBy = this.buildOrderBy(query.sortBy, query.sortOrder);

    const [total, documents] = await this.prisma.$transaction([
      this.prisma.document.count({ where }),
      this.prisma.document.findMany({
        where,
        orderBy,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          code: true,
          title: true,
          fileType: true,
          status: true,
          categoryId: true,
          firstPublishedAt: true,
          revisedAt: true,
          department: { select: { id: true, name: true, code: true } },
          currentRevision: { select: { revisionNo: true } },
        },
      }),
    ]);

    return {
      items: documents.map((document) => ({
        id: document.id,
        code: document.code,
        title: document.title,
        fileType: document.fileType,
        status: document.status,
        categoryId: document.categoryId,
        department: document.department,
        firstPublishedAt: document.firstPublishedAt?.toISOString() ?? null,
        revisedAt: document.revisedAt?.toISOString() ?? null,
        revisionNo: document.currentRevision?.revisionNo ?? null,
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /**
   * Visibility rules (PROJECT.md 6.4), enforced on the server:
   * - READER: published documents only, the status filter is ignored.
   * - EDITOR: published documents plus every non-published document of their own department.
   * - APPROVER, QUALITY_MANAGER, ADMIN: all documents.
   */
  private buildWhere(user: AuthenticatedUser, query: ListDocumentsDto): DocumentWhereInput {
    const and: DocumentWhereInput[] = [{ organizationId: user.organizationId }];

    if (user.role === 'READER') {
      and.push({ status: 'PUBLISHED' });
    } else {
      if (user.role === 'EDITOR') {
        and.push({
          OR: [
            { status: 'PUBLISHED' },
            ...(user.departmentId
              ? [{ departmentId: user.departmentId, status: { not: 'PUBLISHED' as const } }]
              : []),
          ],
        });
      }
      if (query.status) and.push({ status: query.status });
    }

    if (query.categoryId) and.push({ categoryId: query.categoryId });
    if (query.departmentId) and.push({ departmentId: query.departmentId });
    if (query.search) {
      // Prisma passes "contains" to ILIKE unescaped: neutralise the LIKE wildcards
      const search = query.search.replace(/[\\%_]/g, '\\$&');
      and.push({
        OR: [
          { code: { contains: search, mode: 'insensitive' } },
          { title: { contains: search, mode: 'insensitive' } },
        ],
      });
    }

    return { AND: and };
  }

  private buildOrderBy(sortBy: DocumentSortField, sortOrder: SortOrder): DocumentOrderByWithRelationInput[] {
    const primary: DocumentOrderByWithRelationInput = (() => {
      switch (sortBy) {
        case 'title':
          return { title: sortOrder };
        case 'department':
          return { department: { name: sortOrder } };
        case 'firstPublishedAt':
          return { firstPublishedAt: { sort: sortOrder, nulls: 'last' } };
        case 'revisedAt':
          return { revisedAt: { sort: sortOrder, nulls: 'last' } };
        case 'revisionNo':
          // Prisma cannot set null ordering through a relation: Postgres default (nulls last on asc)
          return { currentRevision: { revisionNo: sortOrder } };
        default:
          return { code: sortOrder };
      }
    })();

    // Code is unique per organization: it makes the order stable across pages
    return sortBy === 'code' ? [primary] : [primary, { code: 'asc' }];
  }
}
