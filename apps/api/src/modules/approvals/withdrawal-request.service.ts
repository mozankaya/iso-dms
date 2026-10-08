import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { DocumentDetailDto } from '@iso-dms/shared';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { canRequestWithdrawal, canWriteInDepartment, visibleDocumentWhere } from '../documents/document-access.policy';
import { DocumentsService } from '../documents/documents.service';
import { APPROVAL_STEPS } from './approval-steps';
import type { RequestWithdrawalDto } from './dto/request-withdrawal.dto';

const notWithdrawable = () =>
  new ConflictException({ code: 'DOCUMENT_NOT_WITHDRAWABLE', message: 'Only a published document can be withdrawn' });
const blockedByRevision = () =>
  new ConflictException({
    code: 'WITHDRAWAL_BLOCKED_BY_REVISION',
    message: 'The document has an open revision: give it up or finish it first',
  });
const alreadyRequested = () =>
  new ConflictException({ code: 'WITHDRAWAL_ALREADY_REQUESTED', message: 'A request to withdraw the document is already waiting' });

/**
 * Asks for a document in force to be taken out of use (PROJECT.md 6.2 rule 7). Nothing changes until the last approval:
 * the document stays published and readers keep seeing it. The request goes through the same two steps as a revision.
 */
@Injectable()
export class WithdrawalRequestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    private readonly documents: DocumentsService,
  ) {}

  async request(user: AuthenticatedUser, documentId: string, dto: RequestWithdrawalDto, ipAddress: string | null): Promise<DocumentDetailDto> {
    const found = await this.prisma.document.findFirst({
      where: visibleDocumentWhere(user, documentId),
      select: { id: true, departmentId: true },
    });
    if (!found) throw new NotFoundException({ code: 'DOCUMENT_NOT_FOUND', message: 'Document not found' });
    if (!canWriteInDepartment(user, found.departmentId)) {
      throw new ForbiddenException({ code: 'WITHDRAWAL_NOT_ALLOWED', message: 'Only your own department can ask for this to be withdrawn' });
    }
    const reason = dto.reason?.trim();
    if (!reason) throw new BadRequestException({ code: 'REASON_REQUIRED', message: 'A reason is required' });

    await this.prisma.$transaction(async (tx) => {
      // The document first, like every writer: concurrent requests, revisions and decisions take turns
      await tx.$queryRaw`SELECT id FROM "Document" WHERE id = ${documentId} FOR UPDATE`;
      const document = await tx.document.findUniqueOrThrow({
        where: { id: documentId },
        select: {
          id: true,
          code: true,
          status: true,
          departmentId: true,
          currentRevisionId: true,
          currentRevision: { select: { revisionNo: true } },
          revisions: { select: { status: true } },
        },
      });
      const open = document.revisions.some((revision) => revision.status === 'DRAFT' || revision.status === 'IN_REVIEW');
      const waiting = await tx.documentRequest.count({ where: { documentId, type: 'WITHDRAWAL', status: 'PENDING' } });

      if (!canRequestWithdrawal(user, document, false, false)) throw notWithdrawable();
      if (open) throw blockedByRevision();
      if (waiting > 0) throw alreadyRequested();

      const request = await tx.documentRequest.create({
        data: {
          organizationId: user.organizationId,
          type: 'WITHDRAWAL',
          documentId,
          // The revision in force: what would become invalid, and what the approvers look at
          revisionId: document.currentRevisionId,
          requestedById: user.id,
          reason,
          steps: {
            create: APPROVAL_STEPS.map((approverRole, index) => ({
              organizationId: user.organizationId,
              stepOrder: index + 1,
              approverRole,
            })),
          },
        },
      });

      await this.auditLogs.log(
        {
          organizationId: user.organizationId,
          userId: user.id,
          action: 'WITHDRAWAL_REQUESTED',
          entityType: 'Document',
          entityId: documentId,
          metadata: { code: document.code, revisionNo: document.currentRevision?.revisionNo ?? null, requestId: request.id, reason },
          ipAddress,
        },
        tx,
      );
    });

    return this.documents.findOne(user, documentId);
  }
}
