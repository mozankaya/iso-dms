import type { ApprovalRequestDto } from '@iso-dms/shared';
import type { Prisma } from '../../generated/prisma/client';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { approvalDenial, canCancelRequest } from '../documents/document-access.policy';

/** What is needed to show an approval request and to tell what the current user may do with it. */
export const APPROVAL_REQUEST_INCLUDE = {
  requestedBy: { select: { id: true, fullName: true } },
  revision: { select: { id: true, revisionNo: true, preparedById: true } },
  steps: { orderBy: { stepOrder: 'asc' }, include: { approver: { select: { id: true, fullName: true } } } },
} satisfies Prisma.DocumentRequestInclude;

export type ApprovalRequestRow = Prisma.DocumentRequestGetPayload<{ include: typeof APPROVAL_REQUEST_INCLUDE }>;

/**
 * Who may not decide on a request (PROJECT.md 6.3): whoever prepared the revision under review, and for a withdrawal
 * (which has no draft) whoever asked for it.
 */
export function requestAuthorId(request: { type: string; requestedById: string; revision: { preparedById: string } | null }): string {
  return request.type === 'WITHDRAWAL' || !request.revision ? request.requestedById : request.revision.preparedById;
}

/**
 * Whether it is the turn of a step: it is undecided and every step before it was approved (PROJECT.md 6.3: the
 * department approves first, then the quality manager). A request that is not pending has no turn at all.
 */
export function isStepActive(request: Pick<ApprovalRequestRow, 'status' | 'steps'>, stepOrder: number): boolean {
  if (request.status !== 'PENDING') return false;
  const step = request.steps.find((candidate) => candidate.stepOrder === stepOrder);
  if (!step || step.decision !== 'PENDING') return false;
  return request.steps.filter((earlier) => earlier.stepOrder < stepOrder).every((earlier) => earlier.decision === 'APPROVED');
}

export function toApprovalRequestDto(
  user: AuthenticatedUser,
  request: ApprovalRequestRow,
  document: { departmentId: string },
): ApprovalRequestDto {
  return {
    id: request.id,
    type: request.type,
    status: request.status,
    revision: { id: request.revision!.id, revisionNo: request.revision!.revisionNo },
    requestedBy: request.requestedBy,
    reason: request.reason,
    createdAt: request.createdAt.toISOString(),
    resolvedAt: request.resolvedAt?.toISOString() ?? null,
    steps: request.steps.map((step) => ({
      id: step.id,
      stepOrder: step.stepOrder,
      approverRole: step.approverRole,
      decision: step.decision,
      approver: step.approver,
      comment: step.comment,
      decidedAt: step.decidedAt?.toISOString() ?? null,
      canDecide: isStepActive(request, step.stepOrder) && approvalDenial(user, step, document, { preparedById: requestAuthorId(request) }) === null,
    })),
    canCancel:
      request.status === 'PENDING' &&
      request.steps.every((step) => step.decision === 'PENDING') &&
      canCancelRequest(user, request),
  };
}
