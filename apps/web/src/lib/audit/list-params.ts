import { AUDIT_ACTIONS, DEFAULT_PAGE_SIZE, type AuditAction, type AuditLogQuery } from "@iso-dms/shared";

/** Audit trail filters kept in the URL so a view can be reloaded and shared. */
export interface AuditListParams {
  q: string;
  action: AuditAction | "";
  /** Calendar days, YYYY-MM-DD */
  from: string;
  to: string;
  page: number;
}

export const DEFAULT_AUDIT_PARAMS: AuditListParams = { q: "", action: "", from: "", to: "", page: 1 };

const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

function calendarDay(value: string | null): string {
  if (!value || !CALENDAR_DAY.test(value)) return "";
  // Rejects days that do not exist, such as 2026-02-31
  return new Date(`${value}T00:00:00Z`).toISOString().startsWith(value) ? value : "";
}

/** Reads the filters from a query string. Invalid values fall back to the defaults. */
export function parseAuditParams(searchParams: { get(name: string): string | null }): AuditListParams {
  const page = Number(searchParams.get("page"));
  const action = searchParams.get("action");
  return {
    q: (searchParams.get("q") ?? "").trim(),
    action: AUDIT_ACTIONS.includes(action as AuditAction) ? (action as AuditAction) : "",
    from: calendarDay(searchParams.get("from")),
    to: calendarDay(searchParams.get("to")),
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  };
}

/** Builds the query string ("" or "?a=b") containing only values that differ from the defaults. */
export function toAuditSearchString(params: AuditListParams): string {
  const search = new URLSearchParams();
  if (params.q) search.set("q", params.q);
  if (params.action) search.set("action", params.action);
  if (params.from) search.set("from", params.from);
  if (params.to) search.set("to", params.to);
  if (params.page > 1) search.set("page", String(params.page));
  const text = search.toString();
  return text ? `?${text}` : "";
}

export function toAuditQuery(params: AuditListParams): AuditLogQuery {
  return {
    search: params.q || undefined,
    action: params.action || undefined,
    from: params.from || undefined,
    to: params.to || undefined,
    page: params.page,
    pageSize: DEFAULT_PAGE_SIZE,
  };
}

export function hasActiveAuditFilters(params: AuditListParams): boolean {
  return Boolean(params.q || params.action || params.from || params.to);
}
