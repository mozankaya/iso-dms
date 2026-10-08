import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { approvalStepWaiting, requestApproved, requestRejected } from '../notifications/notification-texts';
import { NotificationsService } from '../notifications/notifications.service';
import { APPROVAL_STEPS } from './approval-steps';

type RequestKind = 'NEW' | 'REVISION' | 'WITHDRAWAL';

interface DocumentRef {
  id: string;
  code: string;
  title: string;
  departmentId: string;
}

/**
 * Tells people about the approval flow (PROJECT.md 6.13): the ones whose turn it is, and the ones who sent the
 * request when it is decided. The messages are written in the transaction of the change they are about; the caller
 * hands the returned ids to `NotificationsService.dispatch` after it commits.
 */
@Injectable()
export class ApprovalNotifier {
  constructor(private readonly notifications: NotificationsService) {}

  /** A step has come up: those who may decide it are told. Not the ones who sent the request: they cannot decide it. */
  async stepWaiting(
    tx: Prisma.TransactionClient,
    input: { organizationId: string; document: DocumentRef; kind: RequestKind; stepOrder: number; excludeUserIds: string[] },
  ): Promise<string[]> {
    const { document } = input;
    const approverRole = APPROVAL_STEPS[input.stepOrder - 1];
    const eligible = (role: 'APPROVER' | 'QUALITY_MANAGER' | 'ADMIN') =>
      tx.user.findMany({
        where: {
          organizationId: input.organizationId,
          role,
          isActive: true,
          id: { notIn: input.excludeUserIds },
          // The first step belongs to the department of the document; the second to the quality management
          ...(role === 'APPROVER' && { departmentId: document.departmentId }),
        },
        select: { id: true },
      });

    // Without anybody in the role the administrators, who may give every step, are the ones to ask
    let recipients = await eligible(approverRole);
    if (recipients.length === 0) recipients = await eligible('ADMIN');

    const content = approvalStepWaiting({ documentId: document.id, code: document.code, title: document.title, kind: input.kind, stepOrder: input.stepOrder });
    return this.notifications.create(
      tx,
      recipients.map((user) => ({ ...content, organizationId: input.organizationId, userId: user.id })),
    );
  }

  /** The request was decided for good (the last approval, or a rejection): those who sent it are told. */
  async decided(
    tx: Prisma.TransactionClient,
    input: {
      organizationId: string;
      document: DocumentRef;
      kind: RequestKind;
      approved: boolean;
      comment: string | null;
      recipientIds: string[];
      deciderId: string;
    },
  ): Promise<string[]> {
    const { document } = input;
    const ref = { documentId: document.id, code: document.code, title: document.title, kind: input.kind };
    const content = input.approved ? requestApproved(ref) : requestRejected({ ...ref, comment: input.comment });
    const recipients = [...new Set(input.recipientIds)].filter((id) => id !== input.deciderId);

    const active = await tx.user.findMany({ where: { organizationId: input.organizationId, id: { in: recipients }, isActive: true }, select: { id: true } });
    return this.notifications.create(
      tx,
      active.map((user) => ({ ...content, organizationId: input.organizationId, userId: user.id })),
    );
  }
}
