import { DEFAULT_PAGE_SIZE, SEARCH_QUERY_MAX_LENGTH, SEARCH_QUERY_MIN_LENGTH, type SearchQuery } from "@iso-dms/shared";

/** State of the search page, kept in the URL. */
export interface SearchParams {
  q: string;
  department: string;
  category: string;
  page: number;
}

export const DEFAULT_SEARCH_PARAMS: SearchParams = { q: "", department: "", category: "", page: 1 };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseSearchParams(searchParams: { get(name: string): string | null }): SearchParams {
  const page = Number(searchParams.get("page"));
  const department = searchParams.get("department") ?? "";
  const category = searchParams.get("category") ?? "";
  return {
    q: (searchParams.get("q") ?? "").trim().slice(0, SEARCH_QUERY_MAX_LENGTH),
    department: UUID_PATTERN.test(department) ? department : "",
    category: UUID_PATTERN.test(category) ? category : "",
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  };
}

/** The query string ("" or "?a=b") with only what differs from the defaults. */
export function toSearchString(params: SearchParams): string {
  const search = new URLSearchParams();
  if (params.q) search.set("q", params.q);
  if (params.department) search.set("department", params.department);
  if (params.category) search.set("category", params.category);
  if (params.page > 1) search.set("page", String(params.page));
  const text = search.toString();
  return text ? `?${text}` : "";
}

export function toSearchQuery(params: SearchParams): SearchQuery {
  return {
    q: params.q,
    departmentId: params.department || undefined,
    categoryId: params.category || undefined,
    page: params.page,
    pageSize: DEFAULT_PAGE_SIZE,
  };
}

/** Whether the words are long enough to be asked of the server. */
export function isSearchable(q: string): boolean {
  return q.trim().length >= SEARCH_QUERY_MIN_LENGTH;
}

export function hasActiveSearchFilters(params: SearchParams): boolean {
  return Boolean(params.department || params.category);
}
