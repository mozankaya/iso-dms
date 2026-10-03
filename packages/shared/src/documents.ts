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
