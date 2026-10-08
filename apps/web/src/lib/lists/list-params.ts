import {
  DEFAULT_LIST_PERIOD,
  DEFAULT_PAGE_SIZE,
  LIST_PERIODS,
  PUBLICATION_LIST_KINDS,
  type ListPeriod,
  type PublicationListKind,
  type PublicationListQuery,
} from "@iso-dms/shared";

/** Publication list state kept in the URL, so a view survives reloads and can be shared. */
export interface PublicationListParams {
  q: string;
  department: string;
  period: ListPeriod;
  page: number;
}

export const DEFAULT_PUBLICATION_PARAMS: PublicationListParams = { q: "", department: "", period: DEFAULT_LIST_PERIOD, page: 1 };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isPublicationListKind(value: string): value is PublicationListKind {
  return (PUBLICATION_LIST_KINDS as readonly string[]).includes(value);
}

/** Reads the state from a query string. Invalid values fall back to the defaults. */
export function parsePublicationParams(searchParams: { get(name: string): string | null }): PublicationListParams {
  const page = Number(searchParams.get("page"));
  const department = searchParams.get("department") ?? "";
  const period = searchParams.get("period");
  return {
    q: (searchParams.get("q") ?? "").trim(),
    department: UUID_PATTERN.test(department) ? department : "",
    period: (LIST_PERIODS as readonly string[]).includes(period ?? "") ? (period as ListPeriod) : DEFAULT_LIST_PERIOD,
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  };
}

/** Builds the query string ("" or "?a=b") containing only values that differ from the defaults. */
export function toPublicationSearchString(params: PublicationListParams): string {
  const search = new URLSearchParams();
  if (params.q) search.set("q", params.q);
  if (params.department) search.set("department", params.department);
  if (params.period !== DEFAULT_LIST_PERIOD) search.set("period", params.period);
  if (params.page > 1) search.set("page", String(params.page));
  const text = search.toString();
  return text ? `?${text}` : "";
}

export function toPublicationQuery(params: PublicationListParams): PublicationListQuery {
  return {
    period: params.period,
    departmentId: params.department || undefined,
    search: params.q || undefined,
    page: params.page,
    pageSize: DEFAULT_PAGE_SIZE,
  };
}

export function hasActivePublicationFilters(params: PublicationListParams): boolean {
  return Boolean(params.q || params.department || params.period !== DEFAULT_LIST_PERIOD);
}
