export const DOCUMENT_STATUSES = ['DRAFT', 'IN_REVIEW', 'PUBLISHED', 'WITHDRAWN'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const FILE_TYPES = ['DOCX', 'XLSX'] as const;
export type FileType = (typeof FILE_TYPES)[number];

export const DOCUMENT_SORT_FIELDS = [
  'code',
  'title',
  'department',
  'firstPublishedAt',
  'revisedAt',
  'revisionNo',
] as const;
export type DocumentSortField = (typeof DOCUMENT_SORT_FIELDS)[number];

export const SORT_ORDERS = ['asc', 'desc'] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export interface PaginatedDto<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface DepartmentDto {
  id: string;
  name: string;
  code: string;
}

export interface DocumentListItemDto {
  id: string;
  code: string;
  title: string;
  fileType: FileType;
  status: DocumentStatus;
  categoryId: string;
  department: DepartmentDto;
  /** ISO 8601 timestamps */
  firstPublishedAt: string | null;
  revisedAt: string | null;
  /** Revision number of the currently valid revision, null if never published */
  revisionNo: number | null;
  /** Whether the current user may edit this document's open draft */
  canEdit: boolean;
}

export interface DocumentListQuery {
  categoryId?: string;
  departmentId?: string;
  status?: DocumentStatus;
  search?: string;
  page?: number;
  pageSize?: number;
  sortBy?: DocumentSortField;
  sortOrder?: SortOrder;
}

export interface TemplateDto {
  id: string;
  name: string;
  fileType: FileType;
  /** null for templates available in every category */
  categoryId: string | null;
  isDefault: boolean;
}

/** Default upload limit; the API enforces its own MAX_UPLOAD_MB setting. */
export const DEFAULT_MAX_UPLOAD_MB = 25;

export interface CreateDocumentRequest {
  categoryId: string;
  departmentId: string;
  title: string;
  fileType: FileType;
  templateId?: string;
}

export const REVISION_STATUSES = ['DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'SUPERSEDED'] as const;
export type RevisionStatus = (typeof REVISION_STATUSES)[number];

export interface RevisionSummaryDto {
  id: string;
  revisionNo: number;
  status: RevisionStatus;
}

export interface PersonDto {
  id: string;
  fullName: string;
}

/** One row of a document's revision history. */
export interface RevisionHistoryItemDto extends RevisionSummaryDto {
  /** Whether this is the revision currently in force */
  isCurrent: boolean;
  preparedBy: PersonDto;
  approvedBy: PersonDto | null;
  /** ISO 8601 timestamps */
  approvedAt: string | null;
  publishedAt: string | null;
  createdAt: string;
  changeSummary: string | null;
  fileSize: number;
  /** Whether the current user may edit this revision */
  canEdit: boolean;
}

/** A document with everything the detail page shows, plus the revision the editor opens for the current user. */
export interface DocumentDetailDto extends DocumentListItemDto {
  /** Null when the user may not open any revision of the document */
  openRevision: RevisionSummaryDto | null;
  category: { id: string; name: string; slug: string };
  owner: PersonDto;
  /** The revision in force, null for documents that were never published */
  currentRevisionId: string | null;
  reviewIntervalMonths: number | null;
  nextReviewAt: string | null;
  retentionYears: number | null;
  withdrawnAt: string | null;
  withdrawalReason: string | null;
  createdAt: string;
}

export type EditorMode = 'edit' | 'view';

export interface EditorSessionDto {
  mode: EditorMode;
  document: { id: string; code: string; title: string; status: DocumentStatus };
  revision: RevisionSummaryDto;
  /** Signed ONLYOFFICE editor configuration, passed to DocsAPI.DocEditor as is */
  config: Record<string, unknown>;
}
