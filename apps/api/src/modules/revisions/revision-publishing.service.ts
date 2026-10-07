import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { DocumentDetailDto } from '@iso-dms/shared';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { canPublishRevision, canViewRevision } from '../documents/document-access.policy';
import { DocumentsService } from '../documents/documents.service';
import { EditSessionGate, editSessionActive } from '../editor/edit-session-gate.service';
import type { PublishRevisionDto } from './dto/publish-revision.dto';

function notPublishable(): ConflictException {
  return new ConflictException({
    code: 'REVISION_NOT_PUBLISHABLE',
    message: 'Only an open draft of a document that was not withdrawn can be published',
  });
}

/**
 * Simple publication (PROJECT.md 6.2 rule 4 without the approval steps): the publisher gives the final go,
 * the draft becomes the revision in force and the one it replaces is superseded. Nothing is deleted.
 */
@Injectable()
export class RevisionPublishingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly editSessions: EditSessionGate,
    private readonly auditLogs: AuditLogsService,
    private readonly documents: DocumentsService,
  ) {}

  async publish(
    user: AuthenticatedUser,
    revisionId: string,
    dto: PublishRevisionDto,
    ipAddress: string | null,
  ): Promise<DocumentDetailDto> {
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
    if (!canPublishRevision(user, revision.document, revision)) throw notPublishable();

    // The summary can be given here or was given when the revision was started
    const changeSummary = dto.changeSummary?.trim() || null;
    if (revision.revisionNo > 0 && !changeSummary && !revision.changeSummary) {
      throw new BadRequestException({
        code: 'CHANGE_SUMMARY_REQUIRED',
        message: 'A change summary is required from the second revision on',
      });
    }

    // Publishing locks the file: whoever is still editing, or whose last changes are still being saved,
    // would lose them. The check has to come before the transaction because it calls another system.
    await this.editSessions.assertIdle(revision.id);

    await this.prisma.$transaction(async (tx) => {
      // Always the document first, then the revision, so concurrent writers can never wait for each other
      await tx.$queryRaw`SELECT id FROM "Document" WHERE id = ${revision.documentId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "Revision" WHERE id = ${revision.id} FOR UPDATE`;

      const [document, current] = await Promise.all([
        tx.document.findUniqueOrThrow({ where: { id: revision.documentId } }),
        tx.revision.findUniqueOrThrow({ where: { id: revision.id } }),
      ]);
      // Someone else may have published or withdrawn while this request waited for the locks
      if (!canPublishRevision(user, document, current)) throw notPublishable();
      // Somebody was given an editing session after the check above. The mark is written together with the
      // status check (EditorConfigService), so seeing it here under the lock is conclusive.
      if (current.editSessionStartedAt !== null) throw editSessionActive();

      const now = new Date();
      let previousRevisionNo: number | null = null;
      if (document.currentRevisionId && document.currentRevisionId !== current.id) {
        const previous = await tx.revision.update({
          where: { id: document.currentRevisionId },
          data: { status: 'SUPERSEDED' },
          select: { revisionNo: true },
        });
        previousRevisionNo = previous.revisionNo;
      }

      await tx.revision.update({
        where: { id: current.id },
        data: {
          status: 'APPROVED',
          approvedById: user.id,
          approvedAt: now,
          publishedAt: now,
          ...(changeSummary && { changeSummary }),
        },
      });
      await tx.document.update({
        where: { id: document.id },
        data: {
          status: 'PUBLISHED',
          currentRevisionId: current.id,
          firstPublishedAt: document.firstPublishedAt ?? now,
          // The first publication is not a revision date; every later one is
          ...(document.firstPublishedAt && { revisedAt: now }),
        },
      });

      await this.auditLogs.log(
        {
          organizationId: user.organizationId,
          userId: user.id,
          action: 'DOCUMENT_PUBLISHED',
          entityType: 'Document',
          entityId: document.id,
          metadata: {
            code: document.code,
            revisionId: current.id,
            revisionNo: current.revisionNo,
            previousRevisionNo,
            firstPublication: document.firstPublishedAt === null,
          },
          ipAddress,
        },
        tx,
      );
    });

    return this.documents.findOne(user, revision.documentId);
  }
}
