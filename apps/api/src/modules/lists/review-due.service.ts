import { Injectable } from '@nestjs/common';
import type { PaginatedDto, ReviewDueItemDto } from '@iso-dms/shared';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import type { DocumentWhereInput } from '../../generated/prisma/models';
import { PrismaService } from '../../prisma/prisma.service';
import { canEditListedDocument } from '../documents/document-access.policy';
import { DOCUMENT_LIST_SELECT, toDocumentListItem } from '../documents/document-list-item';
import type { ListReviewDueDto } from './dto/list-review-due.dto';
import { reviewDueWhere } from './review-due-where';

/** Prisma passes "contains" to ILIKE unescaped: neutralise the LIKE wildcards. */
const escapeLike = (text: string) => text.replace(/[\\%_]/g, '\\$&');

/** Documents in force whose review is due or overdue (PROJECT.md 6.5), the longest overdue first. */
@Injectable()
export class ReviewDueService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: AuthenticatedUser, query: ListReviewDueDto): Promise<PaginatedDto<ReviewDueItemDto>> {
    const now = new Date();
    const filters: DocumentWhereInput[] = [];
    if (query.departmentId) filters.push({ departmentId: query.departmentId });
    if (query.search) {
      const search = escapeLike(query.search);
      filters.push({ OR: [{ code: { contains: search, mode: 'insensitive' } }, { title: { contains: search, mode: 'insensitive' } }] });
    }
    const where: DocumentWhereInput = { AND: [reviewDueWhere(user, now), ...filters] };

    const [total, documents] = await this.prisma.$transaction([
      this.prisma.document.count({ where }),
      this.prisma.document.findMany({
        where,
        // The code breaks ties, so pages stay stable
        orderBy: [{ nextReviewAt: 'asc' }, { code: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: { ...DOCUMENT_LIST_SELECT, nextReviewAt: true, owner: { select: { id: true, fullName: true } } },
      }),
    ]);

    return {
      items: documents.map((document) => {
        const nextReviewAt = document.nextReviewAt!;
        return {
          ...toDocumentListItem(document, canEditListedDocument(user, { status: document.status, departmentId: document.department.id })),
          nextReviewAt: nextReviewAt.toISOString(),
          overdue: nextReviewAt.getTime() < now.getTime(),
          owner: document.owner,
        };
      }),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }
}
