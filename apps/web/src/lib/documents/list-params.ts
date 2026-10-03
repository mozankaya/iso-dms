import {
  DEFAULT_PAGE_SIZE,
  DOCUMENT_SORT_FIELDS,
  DOCUMENT_STATUSES,
  SORT_ORDERS,
  type DocumentListQuery,
  type DocumentSortField,
  type DocumentStatus,
  type SortOrder,
} from "@iso-dms/shared";

/** Document list state kept in the URL so it survives reloads and can be shared. */
export interface ListParams {
  q: string;
  department: string;
  status: DocumentStatus | "";
  sortBy: DocumentSortField;
  sortOrder: SortOrder;
  page: number;
}

export const DEFAULT_LIST_PARAMS: ListParams = {
  q: "",
  department: "",
  status: "",
  sortBy: "code",
  sortOrder: "asc",
  page: 1,
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function oneOf<T extends string>(allowed: readonly T[], value: string | null, fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** Reads list params from a query string. Invalid values fall back to the defaults. */
export function parseListParams(searchParams: { get(name: string): string | null }): ListParams {
  const page = Number(searchParams.get("page"));
  const department = searchParams.get("department") ?? "";

  return {
    q: (searchParams.get("q") ?? "").trim(),
    department: UUID_PATTERN.test(department) ? department : "",
    status: oneOf(DOCUMENT_STATUSES, searchParams.get("status"), "" as DocumentStatus | ""),
    sortBy: oneOf(DOCUMENT_SORT_FIELDS, searchParams.get("sort"), DEFAULT_LIST_PARAMS.sortBy),
    sortOrder: oneOf(SORT_ORDERS, searchParams.get("order"), DEFAULT_LIST_PARAMS.sortOrder),
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  };
}

/** Builds the query string ("" or "?a=b") containing only values that differ from the defaults. */
export function toSearchString(params: ListParams): string {
  const search = new URLSearchParams();
  if (params.q) search.set("q", params.q);
  if (params.department) search.set("department", params.department);
  if (params.status) search.set("status", params.status);
  if (params.sortBy !== DEFAULT_LIST_PARAMS.sortBy) search.set("sort", params.sortBy);
  if (params.sortOrder !== DEFAULT_LIST_PARAMS.sortOrder) search.set("order", params.sortOrder);
  if (params.page > 1) search.set("page", String(params.page));
  const text = search.toString();
  return text ? `?${text}` : "";
}

export function toDocumentQuery(params: ListParams, categoryId: string): DocumentListQuery {
  return {
    categoryId,
    search: params.q || undefined,
    departmentId: params.department || undefined,
    status: params.status || undefined,
    sortBy: params.sortBy,
    sortOrder: params.sortOrder,
    page: params.page,
    pageSize: DEFAULT_PAGE_SIZE,
  };
}

export function hasActiveFilters(params: ListParams): boolean {
  return Boolean(params.q || params.department || params.status);
}
