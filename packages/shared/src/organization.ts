/**
 * Administration of the organization's structure (PROJECT.md 6.9): departments and categories. The patterns and
 * limits live here so the API and the forms of the web app apply exactly the same rules.
 */

/** A department code ends up in every document code ("PR-KK-001") and is never changed. */
export const DEPARTMENT_CODE_PATTERN = /^[A-Z0-9]{2,4}$/;
/** A category prefix does too. */
export const CATEGORY_PREFIX_PATTERN = /^[A-Z]{2,3}$/;

export const ORGANIZATION_NAME_MIN_LENGTH = 2;
export const ORGANIZATION_NAME_MAX_LENGTH = 100;
export const CATEGORY_DESCRIPTION_MAX_LENGTH = 500;
export const CATEGORY_URL_MAX_LENGTH = 500;
export const CATEGORY_SORT_ORDER_MAX = 9999;

/** The icons a category may carry; the web app draws each of them (an unknown name falls back to a folder). */
export const CATEGORY_ICONS = [
  'folder',
  'book-open',
  'clipboard-list',
  'file-signature',
  'file-text',
  'globe',
  'handshake',
  'list-checks',
  'network',
  'workflow',
] as const;
export type CategoryIconName = (typeof CATEGORY_ICONS)[number];

export interface AdminDepartmentDto {
  id: string;
  name: string;
  code: string;
  isActive: boolean;
  /** Users of the department, active or not */
  userCount: number;
  /** Documents of the department in any state */
  documentCount: number;
  /** ISO 8601 */
  createdAt: string;
}

export interface CreateDepartmentRequest {
  name: string;
  code: string;
}

/** The code is not here on purpose: it cannot be changed. */
export interface UpdateDepartmentRequest {
  name?: string;
  isActive?: boolean;
}

export interface AdminCategoryDto {
  id: string;
  name: string;
  slug: string;
  codePrefix: string;
  description: string | null;
  icon: string | null;
  sortOrder: number;
  isExternal: boolean;
  externalUrl: string | null;
  isActive: boolean;
  /** Documents of the category in any state */
  documentCount: number;
  /** ISO 8601 */
  createdAt: string;
}

export interface CreateCategoryRequest {
  name: string;
  codePrefix: string;
  description?: string | null;
  icon?: string | null;
  /** The next free place when missing */
  sortOrder?: number;
  isExternal?: boolean;
  externalUrl?: string | null;
}

/** Slug, prefix and the external flag are not here on purpose: they cannot be changed. */
export interface UpdateCategoryRequest {
  name?: string;
  description?: string | null;
  icon?: string | null;
  sortOrder?: number;
  externalUrl?: string | null;
  isActive?: boolean;
}
