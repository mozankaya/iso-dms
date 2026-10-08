import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { DocumentDetailDto } from '@iso-dms/shared';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { addMonths } from '../../common/utils/dates';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { canMarkReviewed, canSetReviewInterval, isReviewResponsible, visibleDocumentWhere } from './document-access.policy';
import { DocumentsService } from './documents.service';
import type { MarkReviewedDto, UpdateReviewSettingsDto } from './dto/review.dto';

const SELECT = {
  id: true,
  code: true,
  status: true,
  ownerId: true,
  departmentId: true,
  reviewIntervalMonths: true,
  lastReviewedAt: true,
  nextReviewAt: true,
  currentRevision: { select: { revisionNo: true } },
} as const;

const notAllowed = () => new ForbiddenException({ code: 'REVIEW_NOT_ALLOWED', message: 'The review of this document is not yours to manage' });

/**
 * The periodic review of documents in force (PROJECT.md 6.5). Nothing here goes through the approval flow: the
 * period is a setting and "reviewed" is a statement by the one responsible; both are written to the audit trail,
 * which is the proof an auditor asks for.
 */
@Injectable()
export class DocumentReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    private readonly documents: DocumentsService,
  ) {}

  /** Sets (or removes) the review period; the next review is counted from the last one. */
  async updateSettings(user: AuthenticatedUser, documentId: string, dto: UpdateReviewSettingsDto, ipAddress: string | null): Promise<DocumentDetailDto> {
    const found = await this.prisma.document.findFirst({ where: visibleDocumentWhere(user, documentId), select: SELECT });
    if (!found) throw new NotFoundException({ code: 'DOCUMENT_NOT_FOUND', message: 'Document not found' });
    if (!isReviewResponsible(user, found)) throw notAllowed();
    if (!canSetReviewInterval(user, found)) throw new ConflictException({ code: 'DOCUMENT_NOT_REVIEWABLE', message: 'A withdrawn document has no review' });

    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Document" WHERE id = ${documentId} FOR UPDATE`;
      const document = await tx.document.findUniqueOrThrow({ where: { id: documentId }, select: SELECT });
      if (document.status === 'WITHDRAWN') throw new ConflictException({ code: 'DOCUMENT_NOT_REVIEWABLE', message: 'A withdrawn document has no review' });
      // Nothing to change is not an error, and not worth a record
      if (document.reviewIntervalMonths === dto.intervalMonths) return;

      const nextReviewAt = dto.intervalMonths && document.lastReviewedAt ? addMonths(document.lastReviewedAt, dto.intervalMonths) : null;
      await tx.document.update({ where: { id: documentId }, data: { reviewIntervalMonths: dto.intervalMonths, nextReviewAt } });
      await this.auditLogs.log(
        {
          organizationId: user.organizationId,
          userId: user.id,
          action: 'DOCUMENT_REVIEW_SETTINGS_CHANGED',
          entityType: 'Document',
          entityId: documentId,
          metadata: {
            code: document.code,
            from: document.reviewIntervalMonths,
            to: dto.intervalMonths,
            nextReviewAt: nextReviewAt?.toISOString() ?? null,
          },
          ipAddress,
        },
        tx,
      );
    });
    return this.documents.findOne(user, documentId);
  }

  /** "Reviewed, no change needed": the next review is due one period from now. */
  async markReviewed(user: AuthenticatedUser, documentId: string, dto: MarkReviewedDto, ipAddress: string | null): Promise<DocumentDetailDto> {
    const found = await this.prisma.document.findFirst({ where: visibleDocumentWhere(user, documentId), select: SELECT });
    if (!found) throw new NotFoundException({ code: 'DOCUMENT_NOT_FOUND', message: 'Document not found' });
    if (!isReviewResponsible(user, found)) throw notAllowed();
    if (!canMarkReviewed(user, found)) throw new ConflictException({ code: 'DOCUMENT_NOT_REVIEWABLE', message: 'Only a document in force can be reviewed' });

    const note = dto.note || null;
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Document" WHERE id = ${documentId} FOR UPDATE`;
      const document = await tx.document.findUniqueOrThrow({ where: { id: documentId }, select: SELECT });
      if (document.status !== 'PUBLISHED') {
        throw new ConflictException({ code: 'DOCUMENT_NOT_REVIEWABLE', message: 'Only a document in force can be reviewed' });
      }

      const now = new Date();
      const nextReviewAt = document.reviewIntervalMonths ? addMonths(now, document.reviewIntervalMonths) : null;
      await tx.document.update({ where: { id: documentId }, data: { lastReviewedAt: now, nextReviewAt } });
      await this.auditLogs.log(
        {
          organizationId: user.organizationId,
          userId: user.id,
          action: 'DOCUMENT_REVIEWED',
          entityType: 'Document',
          entityId: documentId,
          metadata: {
            code: document.code,
            revisionNo: document.currentRevision?.revisionNo ?? null,
            note,
            previousNextReviewAt: document.nextReviewAt?.toISOString() ?? null,
            nextReviewAt: nextReviewAt?.toISOString() ?? null,
          },
          ipAddress,
        },
        tx,
      );
    });
    return this.documents.findOne(user, documentId);
  }
}
