import { Injectable } from '@nestjs/common';
import type { PaginatedDto, PublicationListItemDto, PublicationListKind } from '@iso-dms/shared';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import type { DocumentOrderByWithRelationInput, DocumentWhereInput } from '../../generated/prisma/models';
import { PrismaService } from '../../prisma/prisma.service';
import { canEditListedDocument } from '../documents/document-access.policy';
import { DOCUMENT_LIST_SELECT, toDocumentListItem } from '../documents/document-list-item';
import type { ListPublicationsDto } from './dto/list-publications.dto';
import { LIST_DATE_FIELD, publicationWhere, windowStart } from './publication-where';

/** Prisma passes "contains" to ILIKE unescaped: neutralise the LIKE wildcards. */
const escapeLike = (text: string) => text.replace(/[\\%_]/g, '\\$&');

/**
 * The publication lists (PROJECT.md 9, screen 8): what was published, revised or withdrawn lately, newest first.
 * Who sees which document is decided by publicationWhere (and so by document-access.policy.ts).
 */
@Injectable()
export class ListsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: AuthenticatedUser, kind: PublicationListKind, query: ListPublicationsDto): Promise<PaginatedDto<PublicationListItemDto>> {
    const since = query.period === 'all' ? null : windowStart(Number(query.period));
    const where: DocumentWhereInput = { AND: [publicationWhere(user, kind, since), ...this.filters(query)] };
    const field = LIST_DATE_FIELD[kind];
    // The code breaks ties, so pages stay stable when several documents share a moment
    const orderBy: DocumentOrderByWithRelationInput[] = [{ [field]: 'desc' }, { code: 'asc' }];

    const [total, documents] = await this.prisma.$transaction([
      this.prisma.document.count({ where }),
      this.prisma.document.findMany({
        where,
        orderBy,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: { ...DOCUMENT_LIST_SELECT, withdrawnAt: true, withdrawalReason: true },
      }),
    ]);

    return {
      items: documents.map((document) => ({
        ...toDocumentListItem(document, canEditListedDocument(user, { status: document.status, departmentId: document.department.id })),
        withdrawnAt: document.withdrawnAt?.toISOString() ?? null,
        withdrawalReason: document.withdrawalReason,
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  private filters(query: ListPublicationsDto): DocumentWhereInput[] {
    const filters: DocumentWhereInput[] = [];
    if (query.departmentId) filters.push({ departmentId: query.departmentId });
    if (query.search) {
      const search = escapeLike(query.search);
      filters.push({
        OR: [
          { code: { contains: search, mode: 'insensitive' } },
          { title: { contains: search, mode: 'insensitive' } },
        ],
      });
    }
    return filters;
  }
}
