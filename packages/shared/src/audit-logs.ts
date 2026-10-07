import type { PaginatedDto } from './documents';

/**
 * Every action the application writes to the audit log. The API only accepts these as a filter, the web
 * translates them; a test keeps the list in step with the actions the code really writes.
 */
export const AUDIT_ACTIONS = [
  'USER_LOGIN',
  'USER_LOGIN_FAILED',
  'USER_LOGOUT',
  'REFRESH_TOKEN_REUSE_DETECTED',
  'DOCUMENT_CREATED',
  'DOCUMENT_OPENED',
  'DOCUMENT_PUBLISHED',
  'REVISION_STARTED',
  'REVISION_SAVED',
  'REVISION_SAVE_REJECTED',
  'REVISION_DOWNLOADED',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_ENTITY_TYPES = ['Document', 'Revision', 'User'] as const;
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

export interface AuditLogUserDto {
  id: string;
  fullName: string;
  email: string;
}

/** The document an entry is about (directly, or through one of its revisions). */
export interface AuditLogDocumentDto {
  id: string;
  code: string;
  title: string;
  /** Set when the entry is about one revision */
  revisionNo: number | null;
}

export interface AuditLogDto {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  /** ISO 8601 timestamp */
  createdAt: string;
  /** null for entries nobody caused (failed logins of unknown accounts) */
  user: AuditLogUserDto | null;
  document: AuditLogDocumentDto | null;
  metadata: Record<string, unknown> | null;
  /** Only the administrator sees addresses; everybody else gets null */
  ipAddress: string | null;
}

export interface AuditLogQuery {
  /** Document code, or part of a user's name or e-mail address */
  search?: string;
  action?: AuditAction;
  entityType?: AuditEntityType;
  userId?: string;
  /** Calendar days (YYYY-MM-DD, Europe/Istanbul), both ends included */
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export type AuditLogPage = PaginatedDto<AuditLogDto>;
