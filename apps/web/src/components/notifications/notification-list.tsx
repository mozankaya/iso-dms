"use client";

import { DEFAULT_PAGE_SIZE, NOTIFICATION_STATUS_FILTERS, type NotificationDto } from "@iso-dms/shared";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Pagination } from "@/components/pagination";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { ApiError } from "@/lib/api/client";
import { getNotifications, markAllNotificationsRead, markNotificationRead } from "@/lib/api/endpoints";
import { formatDateTime } from "@/lib/format";
import { errorMessage, tr } from "@/lib/i18n/tr";
import { parseNotificationParams, toNotificationSearchString, type NotificationListParams } from "@/lib/notifications/list-params";
import { cn } from "@/lib/utils";

const t = tr.notifications;

/** The messages of the user (PROJECT.md 6.13): what is waiting for them and how their requests ended. */
export function NotificationList() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const params = useMemo(() => parseNotificationParams(searchParams), [searchParams]);
  const [error, setError] = useState<string | null>(null);

  const notifications = useQuery({
    queryKey: ["notifications", "list", params],
    queryFn: () => getNotifications({ status: params.status, page: params.page, pageSize: DEFAULT_PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });
  const read = useMutation({ mutationFn: (id: string) => markNotificationRead(id) });
  const readAll = useMutation({ mutationFn: markAllNotificationsRead });

  function update(patch: Partial<NotificationListParams>) {
    router.replace(`${pathname}${toNotificationSearchString({ ...params, page: 1, ...patch })}`, { scroll: false });
  }

  const totalPages = notifications.data ? Math.max(1, Math.ceil(notifications.data.total / DEFAULT_PAGE_SIZE)) : 1;
  const pastLastPage = notifications.data && !notifications.isPlaceholderData && params.page > totalPages;
  useEffect(() => {
    if (pastLastPage) router.replace(`${pathname}${toNotificationSearchString({ ...params, page: totalPages })}`, { scroll: false });
  }, [pastLastPage, params, totalPages, pathname, router]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["notifications"] });

  async function open(notification: NotificationDto) {
    setError(null);
    if (!notification.isRead) {
      try {
        await read.mutateAsync(notification.id);
        await refresh();
      } catch (caught) {
        // Reading the message matters more than marking it
        setError(caught instanceof ApiError ? errorMessage(caught) : tr.errors.NETWORK);
      }
    }
    router.push(notification.link);
  }

  async function markAll() {
    setError(null);
    try {
      await readAll.mutateAsync();
      await refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? errorMessage(caught) : tr.errors.NETWORK);
    }
  }

  const unreadFilter = params.status === "unread";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="notification-status">{t.statusFilter}</Label>
          <Select id="notification-status" className="w-48" value={params.status} onChange={(event) => update({ status: event.target.value as NotificationListParams["status"] })}>
            {NOTIFICATION_STATUS_FILTERS.map((status) => (
              <option key={status} value={status}>
                {t.statuses[status]}
              </option>
            ))}
          </Select>
        </div>
        <Button variant="outline" onClick={markAll} disabled={readAll.isPending}>
          {t.markAllRead}
        </Button>
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {notifications.isPending && (
        <p className="text-muted" role="status">
          {tr.common.loading}
        </p>
      )}
      {notifications.isError && !notifications.data && (
        <div role="alert" className="space-y-2">
          <p className="text-sm text-destructive">{t.loadError}</p>
          <Button variant="outline" size="sm" onClick={() => notifications.refetch()}>
            {tr.common.retry}
          </Button>
        </div>
      )}
      {notifications.data && notifications.data.total === 0 && <p className="py-8 text-center text-muted">{unreadFilter ? t.emptyUnread : t.empty}</p>}

      {notifications.data && notifications.data.total > 0 && (
        <div className={cn("space-y-4", notifications.isPlaceholderData && "opacity-60 transition-opacity")}>
          <ul className="space-y-2" aria-label={t.listLabel}>
            {notifications.data.items.map((item) => (
              <li key={item.id}>
                <Card className={cn("p-0", !item.isRead && "border-primary/40 bg-accent/40")}>
                  <button type="button" onClick={() => open(item)} className="block w-full space-y-1 rounded-lg px-4 py-3 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary">
                    <span className="flex items-start justify-between gap-3">
                      <span className={cn("text-sm", !item.isRead && "font-semibold")}>
                        {!item.isRead && <span className="mr-2 inline-block h-2 w-2 rounded-full bg-primary align-middle" role="img" aria-label={t.unread} />}
                        {item.title}
                      </span>
                      <span className="shrink-0 text-xs text-muted">{formatDateTime(item.createdAt)}</span>
                    </span>
                    <span className="block text-sm break-words text-muted">{item.body}</span>
                  </button>
                </Card>
              </li>
            ))}
          </ul>
          {totalPages > 1 && <Pagination page={params.page} totalPages={totalPages} onPageChange={(page) => update({ page })} />}
        </div>
      )}
    </div>
  );
}
