import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { PdfStatus } from '@iso-dms/shared';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { PdfQueueService } from './pdf-queue.service';

/**
 * A quality manager or administrator asks for the PDF copy of a published revision again (PROJECT.md 6.12):
 * after a failure, or for a revision that was published before copies existed.
 */
@Injectable()
export class PdfRequestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    private readonly queue: PdfQueueService,
  ) {}

  async request(user: AuthenticatedUser, revisionId: string, ipAddress: string | null): Promise<{ id: string; pdfStatus: PdfStatus }> {
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Revision" WHERE id = ${revisionId} AND "organizationId" = ${user.organizationId} FOR UPDATE`;
      const revision = await tx.revision.findFirst({
        where: { id: revisionId, organizationId: user.organizationId },
        select: { id: true, revisionNo: true, publishedAt: true, pdfStatus: true, document: { select: { id: true, code: true } } },
      });
      if (!revision) throw new NotFoundException({ code: 'REVISION_NOT_FOUND', message: 'Revision not found' });
      // Only what was put in force has a copy; and a copy that exists is a record, never made again
      if (!revision.publishedAt) {
        throw new ConflictException({ code: 'REVISION_NOT_PUBLISHED', message: 'Only a revision that was put in force has a PDF copy' });
      }
      if (revision.pdfStatus === 'READY') {
        throw new ConflictException({ code: 'PDF_ALREADY_EXISTS', message: 'The PDF copy of this revision exists already' });
      }

      await tx.revision.update({ where: { id: revisionId }, data: { pdfStatus: 'PENDING', pdfFailureReason: null } });
      await this.auditLogs.log(
        {
          organizationId: user.organizationId,
          userId: user.id,
          action: 'REVISION_PDF_REQUESTED',
          entityType: 'Revision',
          entityId: revisionId,
          metadata: { documentId: revision.document.id, code: revision.document.code, revisionNo: revision.revisionNo, previousStatus: revision.pdfStatus },
          ipAddress,
        },
        tx,
      );
      return { id: revisionId, pdfStatus: 'PENDING' as const };
    });

    // After the commit, like the first time
    await this.queue.enqueue(revisionId);
    return result;
  }
}
