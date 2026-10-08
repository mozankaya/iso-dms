import type { UserRole } from "@iso-dms/shared";

/** Mirrors the API rules (PROJECT.md 6.4); the API enforces them, the UI only reflects them. */
const DOCUMENT_CREATOR_ROLES: readonly UserRole[] = ["EDITOR", "APPROVER", "QUALITY_MANAGER", "ADMIN"];

/** These roles may only create documents in their own department. */
const DEPARTMENT_BOUND_ROLES: readonly UserRole[] = ["EDITOR", "APPROVER"];

/** PROJECT.md 6.4: the audit trail is for quality managers and administrators. */
const AUDIT_LOG_ROLES: readonly UserRole[] = ["QUALITY_MANAGER", "ADMIN"];

export function canViewAuditLog(role: UserRole | undefined): boolean {
  return role !== undefined && AUDIT_LOG_ROLES.includes(role);
}

/** The roles that hold approval steps (PROJECT.md 6.3); the administrator may give either step. */
const APPROVAL_ROLES: readonly UserRole[] = ["APPROVER", "QUALITY_MANAGER", "ADMIN"];

export function canDecideApprovals(role: UserRole | undefined): boolean {
  return role !== undefined && APPROVAL_ROLES.includes(role);
}

/** Readers never see withdrawn documents (PROJECT.md 6.4), so they have no list of them either. */
export function canViewWithdrawnList(role: UserRole | undefined): boolean {
  return role !== undefined && role !== "READER";
}

export function canCreateDocuments(role: UserRole | undefined): boolean {
  return role !== undefined && DOCUMENT_CREATOR_ROLES.includes(role);
}

export function isDepartmentBound(role: UserRole | undefined): boolean {
  return role !== undefined && DEPARTMENT_BOUND_ROLES.includes(role);
}
