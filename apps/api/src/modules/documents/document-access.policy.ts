import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import type { DocumentStatus, RevisionStatus } from '../../generated/prisma/enums';
import type { DocumentWhereInput } from '../../generated/prisma/models';

/**
 * Who may see and edit what (PROJECT.md 6.4). Pure functions so the list, the editor and later the
 * download endpoints all apply exactly the same rules.
 */

/** Roles that may only write in their own department. QUALITY_MANAGER and ADMIN may write anywhere. */
const DEPARTMENT_BOUND_ROLES = ['EDITOR', 'APPROVER'];
const WRITER_ROLES = [...DEPARTMENT_BOUND_ROLES, 'QUALITY_MANAGER', 'ADMIN'];

/** Whether the user may create or edit drafts in a department. */
export function canWriteInDepartment(user: AuthenticatedUser, departmentId: string): boolean {
  if (!WRITER_ROLES.includes(user.role)) return false;
  if (DEPARTMENT_BOUND_ROLES.includes(user.role)) return user.departmentId === departmentId;
  return true;
}

/**
 * Filter limiting a document query to what the user may see; undefined means no restriction.
 * - READER: published documents only.
 * - EDITOR: published documents plus every non-published document of their own department.
 * - APPROVER, QUALITY_MANAGER, ADMIN: all documents.
 */
export function visibilityFilter(user: AuthenticatedUser): DocumentWhereInput | undefined {
  if (user.role === 'READER') return { status: 'PUBLISHED' };
  if (user.role === 'EDITOR') {
    return {
      OR: [
        { status: 'PUBLISHED' },
        ...(user.departmentId ? [{ departmentId: user.departmentId, status: { not: 'PUBLISHED' as const } }] : []),
      ],
    };
  }
  return undefined;
}

/** Where clause for one document by id, limited to the organization and to what the user may see. */
export function visibleDocumentWhere(user: AuthenticatedUser, id: string): DocumentWhereInput {
  const visibility = visibilityFilter(user);
  return { id, organizationId: user.organizationId, ...(visibility && { AND: [visibility] }) };
}

interface DocumentForAccess {
  status: DocumentStatus;
  departmentId: string;
  currentRevisionId: string | null;
}

/**
 * Whether the user may open a revision (read only). Readers and editors of other departments only
 * ever get the revision that is currently in force; old and draft revisions stay with the owning
 * department and the approving roles.
 */
export function canViewRevision(user: AuthenticatedUser, document: DocumentForAccess, revisionId: string): boolean {
  const isInForce = document.status === 'PUBLISHED' && document.currentRevisionId === revisionId;

  switch (user.role) {
    case 'READER':
      return isInForce;
    case 'EDITOR':
      return isInForce || (user.departmentId !== null && user.departmentId === document.departmentId);
    default:
      return true;
  }
}

/** Only an open draft can be edited: everything else (in review, approved, superseded) is view only. */
export function canEditRevision(
  user: AuthenticatedUser,
  document: Pick<DocumentForAccess, 'status' | 'departmentId'>,
  revision: { status: RevisionStatus },
): boolean {
  return (
    revision.status === 'DRAFT' && document.status !== 'WITHDRAWN' && canWriteInDepartment(user, document.departmentId)
  );
}

/**
 * Edit flag shown in lists. A list row has no revision data: a document that is still a draft always
 * has an open draft revision, which is the only case where editing is possible today.
 */
export function canEditListedDocument(
  user: AuthenticatedUser,
  document: { status: DocumentStatus; departmentId: string },
): boolean {
  return document.status === 'DRAFT' && canWriteInDepartment(user, document.departmentId);
}

/**
 * Whether the user may start a new revision of a document (PROJECT.md 6.2 rule 6): the document is in force,
 * nothing is open yet (rule 9: one open draft at a time) and the user may write in its department.
 */
export function canStartRevision(
  user: AuthenticatedUser,
  document: Pick<DocumentForAccess, 'status' | 'departmentId' | 'currentRevisionId'>,
  hasOpenRevision: boolean,
): boolean {
  return (
    document.status === 'PUBLISHED' &&
    document.currentRevisionId !== null &&
    !hasOpenRevision &&
    canWriteInDepartment(user, document.departmentId)
  );
}

/**
 * Whether the user may send a revision to review (PROJECT.md 6.2 rule 3): the same people who may edit the
 * open draft. Whether somebody still has it open in the editor is the business of EditSessionGate.
 */
export function canSubmitRevision(
  user: AuthenticatedUser,
  document: Pick<DocumentForAccess, 'status' | 'departmentId'>,
  revision: { status: RevisionStatus },
): boolean {
  return canEditRevision(user, document, revision);
}

/**
 * Whether the user may give up the open draft of a document in force (a revision that was started and is no
 * longer wanted). A document that was never published has no such way out: its draft is the document.
 */
export function canCancelRevision(
  user: AuthenticatedUser,
  document: Pick<DocumentForAccess, 'status' | 'departmentId' | 'currentRevisionId'>,
  revision: { id: string; status: RevisionStatus },
): boolean {
  return (
    document.status === 'PUBLISHED' &&
    document.currentRevisionId !== null &&
    revision.id !== document.currentRevisionId &&
    revision.status === 'DRAFT' &&
    canWriteInDepartment(user, document.departmentId)
  );
}

export type ApprovalDenial = 'NOT_ALLOWED' | 'OWN_REVISION';

/**
 * Why the user may not decide an approval step, or null when they may (PROJECT.md 6.3): step 1 belongs to the
 * approvers of the document's department, step 2 to the quality managers, the administrator may give either, and
 * whoever prepared the revision decides nothing about it. Whether it is this step's turn is not decided here.
 */
export function approvalDenial(
  user: AuthenticatedUser,
  step: { approverRole: string },
  document: { departmentId: string },
  revision: { preparedById: string },
): ApprovalDenial | null {
  const roleFits =
    user.role === 'ADMIN' ||
    (step.approverRole === 'APPROVER' && user.role === 'APPROVER' && user.departmentId === document.departmentId) ||
    (step.approverRole === 'QUALITY_MANAGER' && user.role === 'QUALITY_MANAGER');
  if (!roleFits) return 'NOT_ALLOWED';
  return revision.preparedById === user.id ? 'OWN_REVISION' : null;
}

/** Whoever sent a revision to review may take it back, and so may the administrator. */
export function canCancelRequest(user: AuthenticatedUser, request: { requestedById: string }): boolean {
  return user.id === request.requestedById || user.role === 'ADMIN';
}
