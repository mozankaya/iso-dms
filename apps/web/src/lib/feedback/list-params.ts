import {
  DEFAULT_PAGE_SIZE,
  FEEDBACK_STATUS_FILTERS,
  LIST_PERIODS,
  type FeedbackQuery,
  type FeedbackStatusFilter,
  type ListPeriod,
} from "@iso-dms/shared";

/** Feedback list state kept in the URL, so a view survives reloads and can be shared. */
export interface FeedbackListParams {
  q: string;
  department: string;
  status: FeedbackStatusFilter;
  period: ListPeriod;
  page: number;
}

/** What needs attention first: the open ones, from all times. */
export const DEFAULT_FEEDBACK_PARAMS: FeedbackListParams = { q: "", department: "", status: "open", period: "all", page: 1 };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function oneOf<T extends string>(allowed: readonly T[], value: string | null, fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** Reads the state from a query string. Invalid values fall back to the defaults. */
export function parseFeedbackParams(searchParams: { get(name: string): string | null }): FeedbackListParams {
  const page = Number(searchParams.get("page"));
  const department = searchParams.get("department") ?? "";
  return {
    q: (searchParams.get("q") ?? "").trim(),
    department: UUID_PATTERN.test(department) ? department : "",
    status: oneOf(FEEDBACK_STATUS_FILTERS, searchParams.get("status"), DEFAULT_FEEDBACK_PARAMS.status),
    period: oneOf(LIST_PERIODS, searchParams.get("period"), DEFAULT_FEEDBACK_PARAMS.period),
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  };
}

/** Builds the query string ("" or "?a=b") containing only values that differ from the defaults. */
export function toFeedbackSearchString(params: FeedbackListParams): string {
  const search = new URLSearchParams();
  if (params.q) search.set("q", params.q);
  if (params.department) search.set("department", params.department);
  if (params.status !== DEFAULT_FEEDBACK_PARAMS.status) search.set("status", params.status);
  if (params.period !== DEFAULT_FEEDBACK_PARAMS.period) search.set("period", params.period);
  if (params.page > 1) search.set("page", String(params.page));
  const text = search.toString();
  return text ? `?${text}` : "";
}

export function toFeedbackQuery(params: FeedbackListParams): FeedbackQuery {
  return {
    status: params.status,
    period: params.period,
    departmentId: params.department || undefined,
    search: params.q || undefined,
    page: params.page,
    pageSize: DEFAULT_PAGE_SIZE,
  };
}

export function hasActiveFeedbackFilters(params: FeedbackListParams): boolean {
  return Boolean(params.q || params.department || params.status !== DEFAULT_FEEDBACK_PARAMS.status || params.period !== DEFAULT_FEEDBACK_PARAMS.period);
}
