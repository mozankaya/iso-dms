import { NOTIFICATION_STATUS_FILTERS, type NotificationStatusFilter } from "@iso-dms/shared";

/** Notification list state kept in the URL. */
export interface NotificationListParams {
  status: NotificationStatusFilter;
  page: number;
}

export const DEFAULT_NOTIFICATION_PARAMS: NotificationListParams = { status: "all", page: 1 };

export function parseNotificationParams(searchParams: { get(name: string): string | null }): NotificationListParams {
  const page = Number(searchParams.get("page"));
  const status = searchParams.get("status");
  return {
    status: NOTIFICATION_STATUS_FILTERS.includes(status as NotificationStatusFilter) ? (status as NotificationStatusFilter) : DEFAULT_NOTIFICATION_PARAMS.status,
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  };
}

/** The query string ("" or "?a=b") with only what differs from the defaults. */
export function toNotificationSearchString(params: NotificationListParams): string {
  const search = new URLSearchParams();
  if (params.status !== DEFAULT_NOTIFICATION_PARAMS.status) search.set("status", params.status);
  if (params.page > 1) search.set("page", String(params.page));
  const text = search.toString();
  return text ? `?${text}` : "";
}
