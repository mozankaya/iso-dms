import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  DocumentDetailDto,
  DocumentListItemDto,
  DocumentSortField,
  PaginatedDto,
  SortOrder,
} from '@iso-dms/shared';
import type { DocumentOrderByWithRelationInput, DocumentWhereInput } from '../../generated/prisma/models';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { PrismaService } from '../../prisma/prisma.service';
import {
  canEditListedDocument,
  canCancelRevision,
  canEditRevision,
  canRequestWithdrawal,
  canViewApproval,
  canStartRevision,
  canSubmitRevision,
  canViewRevision,
  visibilityFilter,
  visibleDocumentWhere,
} from './document-access.policy';
import { APPROVAL_REQUEST_INCLUDE, toApprovalRequestDto } from '../approvals/approval-request.mapper';
import { DOCUMENT_LIST_SELECT, toDocumentListItem } from './document-list-item';
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
        select: DOCUMENT_LIST_SELECT,
      }),
    ]);

    return {
      items: documents.map((document) =>
        toDocumentListItem(
          document,
          canEditListedDocument(user, { status: document.status, departmentId: document.department.id }),
        ),
      ),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /**
   * One document the user may see, with the revision the editor opens for them: the open draft when they
   * may view it, otherwise the revision in force. Documents outside the user's visibility are not found.
   */
  async findOne(user: AuthenticatedUser, id: string): Promise<DocumentDetailDto> {
    const document = await this.prisma.document.findFirst({
      where: visibleDocumentWhere(user, id),
      select: {
        ...DOCUMENT_LIST_SELECT,
        departmentId: true,
        currentRevisionId: true,
        reviewIntervalMonths: true,
        nextReviewAt: true,
        retentionYears: true,
        withdrawnAt: true,
        withdrawalReason: true,
        createdAt: true,
        category: { select: { id: true, name: true, slug: true } },
        owner: { select: { id: true, fullName: true } },
        revisions: {
          orderBy: { revisionNo: 'desc' },
          select: { id: true, revisionNo: true, status: true, changeSummary: true },
        },
      },
    });
    if (!document) {
      throw new NotFoundException({ code: 'DOCUMENT_NOT_FOUND', message: 'Document not found' });
    }

    const viewable = document.revisions.filter((revision) => canViewRevision(user, document, revision.id));
    const openDraft = viewable.find((revision) => revision.status === 'DRAFT');
    const inForce = viewable.find((revision) => revision.id === document.currentRevisionId);
    const openRevision = openDraft ?? inForce ?? viewable[0] ?? null;

    const canEdit = openRevision !== null && canEditRevision(user, document, openRevision);

    // A request to withdraw the document, while it waits for its decisions
    const pendingWithdrawal = await this.prisma.documentRequest.findFirst({
      where: { organizationId: user.organizationId, documentId: document.id, type: 'WITHDRAWAL', status: 'PENDING' },
      include: APPROVAL_REQUEST_INCLUDE,
    });

    // The approval of the revision that is being reviewed, or else of the open draft (the last one, if it was rejected)
    const underApproval = viewable.find((revision) => revision.status === 'IN_REVIEW') ?? openDraft;
    const revisionApproval =
      !pendingWithdrawal && underApproval
        ? await this.prisma.documentRequest.findFirst({
            where: { organizationId: user.organizationId, revisionId: underApproval.id },
            orderBy: { createdAt: 'desc' },
            include: APPROVAL_REQUEST_INCLUDE,
          })
        : null;
    const approval = canViewApproval(user, document) ? (pendingWithdrawal ?? revisionApproval) : null;
    const hasOpenRevision = document.revisions.some((revision) => revision.status === 'DRAFT' || revision.status === 'IN_REVIEW');
    return {
      ...toDocumentListItem(document, canEdit),
      openRevision,
      category: document.category,
      owner: document.owner,
      currentRevisionId: document.currentRevisionId,
      reviewIntervalMonths: document.reviewIntervalMonths,
      nextReviewAt: document.nextReviewAt?.toISOString() ?? null,
      retentionYears: document.retentionYears,
      withdrawnAt: document.withdrawnAt?.toISOString() ?? null,
      withdrawalReason: document.withdrawalReason,
      createdAt: document.createdAt.toISOString(),
      canSubmit: openDraft !== undefined && canSubmitRevision(user, document, openDraft),
      canCancelRevision: openDraft !== undefined && canCancelRevision(user, document, openDraft),
      approval: approval ? toApprovalRequestDto(user, approval, document) : null,
      canStartRevision: canStartRevision(user, document, hasOpenRevision, pendingWithdrawal !== null),
      canRequestWithdrawal: canRequestWithdrawal(user, document, hasOpenRevision, pendingWithdrawal !== null),
    };
  }

  /** Visibility rules live in document-access.policy.ts. */
  private buildWhere(user: AuthenticatedUser, query: ListDocumentsDto): DocumentWhereInput {
    const and: DocumentWhereInput[] = [{ organizationId: user.organizationId }];

    const visibility = visibilityFilter(user);
    if (visibility) and.push(visibility);
    // Readers only ever see published documents: a status filter cannot widen that
    if (query.status && user.role !== 'READER') and.push({ status: query.status });

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
