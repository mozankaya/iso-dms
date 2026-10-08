import { DEFAULT_PAGE_SIZE, type ReviewDueQuery } from "@iso-dms/shared";

/** State of the list of reviews that are due, kept in the URL. */
export interface ReviewDueParams {
  q: string;
  department: string;
  page: number;
}

export const DEFAULT_REVIEW_DUE_PARAMS: ReviewDueParams = { q: "", department: "", page: 1 };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseReviewDueParams(searchParams: { get(name: string): string | null }): ReviewDueParams {
  const page = Number(searchParams.get("page"));
  const department = searchParams.get("department") ?? "";
  return {
    q: (searchParams.get("q") ?? "").trim(),
    department: UUID_PATTERN.test(department) ? department : "",
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  };
}

/** The query string ("" or "?a=b") with only what differs from the defaults. */
export function toReviewDueSearchString(params: ReviewDueParams): string {
  const search = new URLSearchParams();
  if (params.q) search.set("q", params.q);
  if (params.department) search.set("department", params.department);
  if (params.page > 1) search.set("page", String(params.page));
  const text = search.toString();
  return text ? `?${text}` : "";
}

export function toReviewDueQuery(params: ReviewDueParams): ReviewDueQuery {
  return { departmentId: params.department || undefined, search: params.q || undefined, page: params.page, pageSize: DEFAULT_PAGE_SIZE };
}

export function hasActiveReviewDueFilters(params: ReviewDueParams): boolean {
  return Boolean(params.q || params.department);
}
