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

/** Roles that give the final go for publication (PROJECT.md 6.4: "Son onay ve yayınlama"). */
const PUBLISHER_ROLES = ['QUALITY_MANAGER', 'ADMIN'];

/**
 * Whether the user may publish a revision. Only an open draft can be published, and nothing of a
 * withdrawn document. (Until the approval flow exists the publisher may also be the preparer.)
 */
export function canPublishRevision(
  user: AuthenticatedUser,
  document: Pick<DocumentForAccess, 'status'>,
  revision: { status: RevisionStatus },
): boolean {
  return PUBLISHER_ROLES.includes(user.role) && revision.status === 'DRAFT' && document.status !== 'WITHDRAWN';
}
