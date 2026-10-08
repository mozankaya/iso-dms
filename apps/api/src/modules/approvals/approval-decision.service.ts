import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { DocumentDetailDto } from '@iso-dms/shared';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { approvalDenial } from '../documents/document-access.policy';
import { DocumentsService } from '../documents/documents.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PdfQueueService } from '../pdf/pdf-queue.service';
import { SearchIndexService } from '../search/search-index.service';
import { RevisionPublicationService } from '../revisions/revision-publication.service';
import { ApprovalNotifier } from './approval-notifier.service';
import { DocumentWithdrawalService } from './document-withdrawal.service';
import { APPROVAL_REQUEST_INCLUDE, isStepActive, requestAuthorId } from './approval-request.mapper';
import type { DecideApprovalDto } from './dto/decide-approval.dto';

/**
 * Decisions on the steps of an approval request (PROJECT.md 6.3). The last approval puts the revision in force,
 * a rejection hands the draft back to its authors, and both end the request.
 */
@Injectable()
export class ApprovalDecisionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    private readonly publication: RevisionPublicationService,
    private readonly withdrawal: DocumentWithdrawalService,
    private readonly documents: DocumentsService,
    private readonly pdfQueue: PdfQueueService,
    private readonly searchIndex: SearchIndexService,
    private readonly notifier: ApprovalNotifier,
    private readonly notifications: NotificationsService,
  ) {}

  approve(user: AuthenticatedUser, stepId: string, dto: DecideApprovalDto, ipAddress: string | null): Promise<DocumentDetailDto> {
    return this.decide(user, stepId, 'APPROVED', dto, ipAddress);
  }

  reject(user: AuthenticatedUser, stepId: string, dto: DecideApprovalDto, ipAddress: string | null): Promise<DocumentDetailDto> {
    return this.decide(user, stepId, 'REJECTED', dto, ipAddress);
  }

  private async decide(
    user: AuthenticatedUser,
    stepId: string,
    decision: 'APPROVED' | 'REJECTED',
    dto: DecideApprovalDto,
    ipAddress: string | null,
  ): Promise<DocumentDetailDto> {
    const step = await this.prisma.approvalStep.findFirst({
      where: { id: stepId, organizationId: user.organizationId },
      include: {
        request: {
          select: {
            id: true,
            type: true,
            requestedById: true,
            documentId: true,
            revision: { select: { id: true, preparedById: true } },
            document: { select: { id: true, departmentId: true } },
          },
        },
      },
    });
    if (!step || !step.request.document || !step.request.revision) {
      throw new NotFoundException({ code: 'APPROVAL_STEP_NOT_FOUND', message: 'Approval step not found' });
    }

    const denial = approvalDenial(user, step, step.request.document, { preparedById: requestAuthorId(step.request) });
    if (denial === 'NOT_ALLOWED') {
      throw new ForbiddenException({ code: 'APPROVAL_NOT_ALLOWED', message: 'This step is not yours to decide' });
    }
    if (denial === 'OWN_REVISION') {
      throw new ForbiddenException({ code: 'OWN_REVISION_NOT_APPROVABLE', message: 'You cannot decide on a revision you prepared' });
    }

    const comment = dto.comment?.trim() || null;
    if (decision === 'REJECTED' && !comment) {
      throw new BadRequestException({ code: 'COMMENT_REQUIRED', message: 'A reason is required to reject' });
    }

    const documentId = step.request.document.id;
    let publishedRevisionId: string | null = null;
    let notified: string[] = [];
    await this.prisma.$transaction(async (tx) => {
      // Always the document first, then the revision (like every other writer), so decisions on the same
      // document are taken one after the other
      await tx.$queryRaw`SELECT id FROM "Document" WHERE id = ${documentId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "Revision" WHERE id = ${step.request.revision!.id} FOR UPDATE`;

      const request = await tx.documentRequest.findUniqueOrThrow({ where: { id: step.request.id }, include: APPROVAL_REQUEST_INCLUDE });
      const current = request.steps.find((candidate) => candidate.id === step.id)!;
      // Somebody may have decided, or the request was taken back, while this request waited for the locks
      if (request.status !== 'PENDING') {
        throw new ConflictException({ code: 'APPROVAL_NOT_PENDING', message: 'The request is no longer waiting for a decision' });
      }
      if (current.decision !== 'PENDING') {
        throw new ConflictException({ code: 'STEP_ALREADY_DECIDED', message: 'This step has already been decided' });
      }
      if (!isStepActive(request, current.stepOrder)) {
        throw new ConflictException({ code: 'APPROVAL_STEP_NOT_ACTIVE', message: 'An earlier step has not been approved yet' });
      }

      const now = new Date();
      await tx.approvalStep.update({
        where: { id: current.id },
        data: { decision, approverId: user.id, comment, decidedAt: now },
      });

      const revision = await tx.revision.findUniqueOrThrow({ where: { id: request.revision!.id } });
      const document = await tx.document.findUniqueOrThrow({ where: { id: documentId } });
      const isFinal = decision === 'APPROVED' && request.steps.every((other) => other.id === current.id || other.decision === 'APPROVED');

      const withdrawal = request.type === 'WITHDRAWAL';
      if (decision === 'REJECTED') {
        await tx.documentRequest.update({ where: { id: request.id }, data: { status: 'REJECTED', resolvedAt: now } });
        // The draft goes back to its authors; a document that was never in force is a draft again. A refused
        // withdrawal leaves the document as it is.
        if (!withdrawal) {
          await tx.revision.update({ where: { id: revision.id }, data: { status: 'DRAFT' } });
          if (document.status === 'IN_REVIEW') await tx.document.update({ where: { id: document.id }, data: { status: 'DRAFT' } });
        }
      } else if (isFinal) {
        await tx.documentRequest.update({ where: { id: request.id }, data: { status: 'APPROVED', resolvedAt: now } });
      }

      await this.auditLogs.log(
        {
          organizationId: user.organizationId,
          userId: user.id,
          action: decision === 'APPROVED' ? 'APPROVAL_APPROVED' : 'APPROVAL_REJECTED',
          entityType: 'Revision',
          entityId: revision.id,
          metadata: {
            documentId,
            code: document.code,
            revisionNo: revision.revisionNo,
            requestId: request.id,
            stepOrder: current.stepOrder,
            comment,
            type: request.type,
            final: isFinal,
          },
          ipAddress,
        },
        tx,
      );

      if (isFinal && withdrawal) {
        await this.withdrawal.withdraw(tx, { user, document, revision, reason: request.reason, requestId: request.id, ipAddress });
      } else if (isFinal) {
        await this.publication.publish(tx, { user, document, revision, ipAddress });
        publishedRevisionId = revision.id;
      }

      // Whose turn it is, or how it ended, is told in the same transaction as the decision itself
      const documentRef = { id: document.id, code: document.code, title: document.title, departmentId: document.departmentId };
      if (decision === 'APPROVED' && !isFinal) {
        notified = await this.notifier.stepWaiting(tx, {
          organizationId: user.organizationId,
          document: documentRef,
          kind: request.type,
          stepOrder: current.stepOrder + 1,
          excludeUserIds: [request.requestedById, revision.preparedById, user.id],
        });
      } else {
        notified = await this.notifier.decided(tx, {
          organizationId: user.organizationId,
          document: documentRef,
          kind: request.type,
          approved: decision === 'APPROVED',
          comment,
          // Who sent the request and, for a revision, who prepared it
          recipientIds: withdrawal ? [request.requestedById] : [request.requestedById, revision.preparedById],
          deciderId: user.id,
        });
      }
    });
    await this.notifications.dispatch(notified);

    // After the commit, so the worker finds the revision published. Best effort: the sweep covers a lost job.
    if (publishedRevisionId) {
      await this.pdfQueue.enqueue(publishedRevisionId);
      // Also best effort: the sweep indexes whatever is missing
      await this.searchIndex.indexSafely(publishedRevisionId);
    }

    return this.documents.findOne(user, documentId);
  }
}
