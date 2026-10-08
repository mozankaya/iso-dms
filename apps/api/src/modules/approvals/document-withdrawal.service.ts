import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { AuditLogsService } from '../audit-logs/audit-logs.service';

/**
 * Takes a document out of use (PROJECT.md 6.2 rule 7). It only runs when the last approval step of a withdrawal request
 * is approved, in the transaction of that decision: the caller has locked the document.
 */
@Injectable()
export class DocumentWithdrawalService {
  constructor(private readonly auditLogs: AuditLogsService) {}

  /**
   * The document becomes WITHDRAWN. Nothing is deleted: the revision that was in force stays on record (shown as
   * invalid), only nothing is in force any more, so readers no longer see the document.
   */
  async withdraw(
    tx: Prisma.TransactionClient,
    input: {
      user: AuthenticatedUser;
      document: { id: string; code: string };
      revision: { id: string; revisionNo: number };
      reason: string;
      requestId: string;
      ipAddress: string | null;
    },
  ): Promise<void> {
    const { user, document, revision } = input;
    await tx.document.update({
      where: { id: document.id },
      data: { status: 'WITHDRAWN', withdrawnAt: new Date(), withdrawalReason: input.reason },
    });

    await this.auditLogs.log(
      {
        organizationId: user.organizationId,
        userId: user.id,
        action: 'DOCUMENT_WITHDRAWN',
        entityType: 'Document',
        entityId: document.id,
        metadata: { code: document.code, revisionNo: revision.revisionNo, requestId: input.requestId, reason: input.reason },
        ipAddress: input.ipAddress,
      },
      tx,
    );
  }
}
