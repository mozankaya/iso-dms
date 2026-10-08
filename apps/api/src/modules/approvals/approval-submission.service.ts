import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { DocumentDetailDto } from '@iso-dms/shared';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { canSubmitRevision, canViewRevision, canWriteInDepartment } from '../documents/document-access.policy';
import { DocumentsService } from '../documents/documents.service';
import { editSessionActive, EditSessionGate } from '../editor/edit-session-gate.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ApprovalNotifier } from './approval-notifier.service';
import { APPROVAL_STEPS } from './approval-steps';

const notSubmittable = () =>
  new ConflictException({
    code: 'REVISION_NOT_SUBMITTABLE',
    message: 'Only an open draft of a document that was not withdrawn can be sent to review',
  });

/**
 * Sends a draft to review (PROJECT.md 6.2 rule 3): the revision is locked, and a request with its approval steps
 * is opened. Nothing about the file changes, so whoever is still editing it must be finished first.
 */
@Injectable()
export class ApprovalSubmissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly editSessions: EditSessionGate,
    private readonly auditLogs: AuditLogsService,
    private readonly documents: DocumentsService,
    private readonly notifier: ApprovalNotifier,
    private readonly notifications: NotificationsService,
  ) {}

  async submit(user: AuthenticatedUser, revisionId: string, ipAddress: string | null): Promise<DocumentDetailDto> {
    const revision = await this.prisma.revision.findFirst({
      where: { id: revisionId, organizationId: user.organizationId },
      include: {
        document: { select: { id: true, code: true, status: true, departmentId: true, currentRevisionId: true } },
      },
    });
    // Revisions the user may not see are reported as missing, so their existence does not leak
    if (!revision || !canViewRevision(user, revision.document, revision.id)) {
      throw new NotFoundException({ code: 'REVISION_NOT_FOUND', message: 'Revision not found' });
    }
    if (!canWriteInDepartment(user, revision.document.departmentId)) {
      throw new ForbiddenException({ code: 'SUBMIT_NOT_ALLOWED', message: 'Only your own department can send this to review' });
    }
    if (!canSubmitRevision(user, revision.document, revision)) throw notSubmittable();

    // Whoever is editing, or whose last changes are still being saved, would lose them: the check comes before the
    // transaction because it calls another system.
    await this.editSessions.assertIdle(revision.id);

    let notified: string[] = [];
    await this.prisma.$transaction(async (tx) => {
      // Always the document first, then the revision, so concurrent writers can never wait for each other
      await tx.$queryRaw`SELECT id FROM "Document" WHERE id = ${revision.documentId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "Revision" WHERE id = ${revision.id} FOR UPDATE`;
      const [document, current] = await Promise.all([
        tx.document.findUniqueOrThrow({ where: { id: revision.documentId } }),
        tx.revision.findUniqueOrThrow({ where: { id: revision.id } }),
      ]);
      if (!canSubmitRevision(user, document, current)) throw notSubmittable();
      // Somebody was given an editing session after the check above (see EditorConfigService)
      if (current.editSessionStartedAt !== null) throw editSessionActive();

      // A document that is not in force yet is a new document, otherwise this is a revision of one
      const type = document.currentRevisionId ? 'REVISION' : 'NEW';
      const request = await tx.documentRequest.create({
        data: {
          organizationId: user.organizationId,
          type,
          documentId: document.id,
          revisionId: current.id,
          requestedById: user.id,
          reason: current.changeSummary ?? '',
          steps: {
            create: APPROVAL_STEPS.map((approverRole, index) => ({
              organizationId: user.organizationId,
              stepOrder: index + 1,
              approverRole,
            })),
          },
        },
      });
      await tx.revision.update({ where: { id: current.id }, data: { status: 'IN_REVIEW' } });
      if (document.status === 'DRAFT') await tx.document.update({ where: { id: document.id }, data: { status: 'IN_REVIEW' } });

      await this.auditLogs.log(
        {
          organizationId: user.organizationId,
          userId: user.id,
          action: 'REVISION_SUBMITTED',
          entityType: 'Revision',
          entityId: current.id,
          metadata: { documentId: document.id, code: document.code, revisionNo: current.revisionNo, requestId: request.id, type },
          ipAddress,
        },
        tx,
      );

      // The first step is up: the approvers of the department are told (not the ones who prepared or sent it)
      notified = await this.notifier.stepWaiting(tx, {
        organizationId: user.organizationId,
        document,
        kind: type,
        stepOrder: 1,
        excludeUserIds: [user.id, current.preparedById],
      });
    });
    await this.notifications.dispatch(notified);

    return this.documents.findOne(user, revision.documentId);
  }
}
