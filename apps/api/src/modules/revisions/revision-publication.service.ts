import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { AuditLogsService } from '../audit-logs/audit-logs.service';

/**
 * Puts a revision in force (PROJECT.md 6.2 rule 4). It only runs when the last approval step is approved, in
 * the transaction of that decision: the caller has locked the document and the revision and checked that
 * everything is in order.
 */
@Injectable()
export class RevisionPublicationService {
  constructor(private readonly auditLogs: AuditLogsService) {}

  /**
   * The previous revision in force is superseded, the revision becomes the one in force and the document is
   * published. `user` is the one who gave the final approval. Nothing is deleted, and the file does not change.
   */
  async publish(
    tx: Prisma.TransactionClient,
    input: {
      user: AuthenticatedUser;
      document: { id: string; code: string; firstPublishedAt: Date | null; currentRevisionId: string | null };
      revision: { id: string; revisionNo: number };
      ipAddress: string | null;
    },
  ): Promise<void> {
    const { user, document, revision } = input;
    const now = new Date();

    let previousRevisionNo: number | null = null;
    if (document.currentRevisionId && document.currentRevisionId !== revision.id) {
      const previous = await tx.revision.update({
        where: { id: document.currentRevisionId },
        data: { status: 'SUPERSEDED' },
        select: { revisionNo: true },
      });
      previousRevisionNo = previous.revisionNo;
    }

    await tx.revision.update({
      where: { id: revision.id },
      data: { status: 'APPROVED', approvedById: user.id, approvedAt: now, publishedAt: now },
    });
    await tx.document.update({
      where: { id: document.id },
      data: {
        status: 'PUBLISHED',
        currentRevisionId: revision.id,
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
          revisionId: revision.id,
          revisionNo: revision.revisionNo,
          previousRevisionNo,
          firstPublication: document.firstPublishedAt === null,
        },
        ipAddress: input.ipAddress,
      },
      tx,
    );
  }
}
