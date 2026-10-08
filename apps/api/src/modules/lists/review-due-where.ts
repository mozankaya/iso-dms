import { REVIEW_DUE_WINDOW_DAYS } from '@iso-dms/shared';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import type { DocumentWhereInput } from '../../generated/prisma/models';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The documents whose periodic review is the user's to do and is due within the window (or overdue), PROJECT.md 6.5.
 * Mirrors `isReviewResponsible` (document-access.policy.ts): quality managers and administrators answer for all,
 * approvers for their department and what they own, everybody else for what they own. The list and the dashboard
 * counter share this, so the number never promises more than the list shows.
 */
export function reviewDueWhere(user: AuthenticatedUser, now = new Date()): DocumentWhereInput {
  const until = new Date(now.getTime() + REVIEW_DUE_WINDOW_DAYS * DAY_MS);
  const responsibility: DocumentWhereInput[] =
    user.role === 'QUALITY_MANAGER' || user.role === 'ADMIN'
      ? []
      : [
          {
            OR: [{ ownerId: user.id }, ...(user.role === 'APPROVER' && user.departmentId ? [{ departmentId: user.departmentId }] : [])],
          },
        ];

  return {
    AND: [{ organizationId: user.organizationId }, { status: 'PUBLISHED' }, { nextReviewAt: { not: null, lte: until } }, ...responsibility],
  };
}
