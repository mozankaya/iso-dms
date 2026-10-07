import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { DocumentDetailDto } from '@iso-dms/shared';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { canCancelRevision, canViewRevision, canWriteInDepartment } from '../documents/document-access.policy';
import { DocumentsService } from '../documents/documents.service';
import { editSessionActive, EditSessionGate } from '../editor/edit-session-gate.service';
import type { CancelRevisionDto } from './dto/cancel-revision.dto';

const notCancellable = () =>
  new ConflictException({
    code: 'REVISION_NOT_CANCELLABLE',
    message: 'Only an open draft of a document in force can be given up',
  });

/**
 * Gives up a revision that was started and is no longer wanted. The draft is marked REJECTED and stays on record
 * with its file (nothing is deleted), the document stays as it is, and a new revision can be started.
 */
@Injectable()
export class RevisionCancellationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly editSessions: EditSessionGate,
    private readonly auditLogs: AuditLogsService,
    private readonly documents: DocumentsService,
  ) {}

  async cancel(user: AuthenticatedUser, revisionId: string, dto: CancelRevisionDto, ipAddress: string | null): Promise<DocumentDetailDto> {
    const revision = await this.prisma.revision.findFirst({
      where: { id: revisionId, organizationId: user.organizationId },
      include: {
        document: { select: { id: true, code: true, status: true, departmentId: true, currentRevisionId: true } },
      },
    });
    if (!revision || !canViewRevision(user, revision.document, revision.id)) {
      throw new NotFoundException({ code: 'REVISION_NOT_FOUND', message: 'Revision not found' });
    }
    if (!canWriteInDepartment(user, revision.document.departmentId)) {
      throw new ForbiddenException({ code: 'CANCEL_NOT_ALLOWED', message: 'Only your own department can give this up' });
    }
    const reason = dto.reason?.trim();
    if (!reason) throw new BadRequestException({ code: 'REASON_REQUIRED', message: 'A reason is required' });
    if (!canCancelRevision(user, revision.document, revision)) throw notCancellable();

    // Whoever is still editing the draft would lose changes the moment it is locked
    await this.editSessions.assertIdle(revision.id);

    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Document" WHERE id = ${revision.documentId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "Revision" WHERE id = ${revision.id} FOR UPDATE`;
      const [document, current] = await Promise.all([
        tx.document.findUniqueOrThrow({ where: { id: revision.documentId } }),
        tx.revision.findUniqueOrThrow({ where: { id: revision.id } }),
      ]);
      if (!canCancelRevision(user, document, current)) throw notCancellable();
      if (current.editSessionStartedAt !== null) throw editSessionActive();

      await tx.revision.update({ where: { id: current.id }, data: { status: 'REJECTED' } });
      await this.auditLogs.log(
        {
          organizationId: user.organizationId,
          userId: user.id,
          action: 'REVISION_CANCELLED',
          entityType: 'Revision',
          entityId: current.id,
          metadata: { documentId: document.id, code: document.code, revisionNo: current.revisionNo, reason },
          ipAddress,
        },
        tx,
      );
    });

    return this.documents.findOne(user, revision.documentId);
  }
}
