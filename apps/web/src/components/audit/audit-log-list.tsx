"use client";

import { AUDIT_ACTIONS, DEFAULT_PAGE_SIZE } from "@iso-dms/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { AuditLogTable } from "@/components/audit/audit-log-table";
import { Pagination } from "@/components/pagination";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { getAuditLogs } from "@/lib/api/endpoints";
import { useAuth } from "@/lib/auth/auth-context";
import { canViewAuditLog } from "@/lib/auth/permissions";
import {
  hasActiveAuditFilters,
  parseAuditParams,
  toAuditQuery,
  toAuditSearchString,
  type AuditListParams,
} from "@/lib/audit/list-params";
import { actionLabel } from "@/lib/audit/describe";
import { tr } from "@/lib/i18n/tr";

const t = tr.audit;
const SEARCH_DEBOUNCE_MS = 300;

/** The organization-wide audit trail (PROJECT.md 6.4: quality managers and administrators). */
export function AuditLogList() {
  const { user } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const params = useMemo(() => parseAuditParams(searchParams), [searchParams]);
  const allowed = canViewAuditLog(user?.role);

  const [searchText, setSearchText] = useState(params.q);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(debounceTimer.current), []);

  function update(patch: Partial<AuditListParams>) {
    router.replace(`${pathname}${toAuditSearchString({ ...params, page: 1, ...patch })}`, { scroll: false });
  }

  function onSearchChange(value: string) {
    setSearchText(value);
    clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => update({ q: value.trim() }), SEARCH_DEBOUNCE_MS);
  }

  function clearFilters() {
    clearTimeout(debounceTimer.current);
    setSearchText("");
    update({ q: "", action: "", from: "", to: "" });
  }

  const logs = useQuery({
    queryKey: ["audit-logs", params],
    queryFn: () => getAuditLogs(toAuditQuery(params)),
    placeholderData: keepPreviousData,
    enabled: allowed,
  });

  const totalPages = logs.data ? Math.max(1, Math.ceil(logs.data.total / DEFAULT_PAGE_SIZE)) : 1;

  // A shared link may point past the last page
  const pastLastPage = logs.data && !logs.isPlaceholderData && params.page > totalPages;
  useEffect(() => {
    if (pastLastPage) {
      router.replace(`${pathname}${toAuditSearchString({ ...params, page: totalPages })}`, { scroll: false });
    }
  }, [pastLastPage, params, totalPages, pathname, router]);

  if (!allowed) {
    return (
      <p role="alert" className="text-destructive">
        {t.forbidden}
      </p>
    );
  }

  const filtered = hasActiveAuditFilters(params);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end">
        <div className="space-y-1.5">
          <Label htmlFor="audit-search">{t.searchLabel}</Label>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
            <Input
              id="audit-search"
              type="search"
              className="pl-9"
              placeholder={t.searchPlaceholder}
              value={searchText}
              onChange={(event) => onSearchChange(event.target.value)}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="audit-action">{t.actionFilter}</Label>
          <Select
            id="audit-action"
            value={params.action}
            onChange={(event) => update({ action: event.target.value as AuditListParams["action"] })}
          >
            <option value="">{t.allActions}</option>
            {AUDIT_ACTIONS.map((action) => (
              <option key={action} value={action}>
                {actionLabel(action)}
              </option>
            ))}
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="audit-from">{t.fromDate}</Label>
          <Input id="audit-from" type="date" value={params.from} max={params.to || undefined} onChange={(event) => update({ from: event.target.value })} />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="audit-to">{t.toDate}</Label>
          <Input id="audit-to" type="date" value={params.to} min={params.from || undefined} onChange={(event) => update({ to: event.target.value })} />
        </div>

        {filtered && (
          <Button variant="ghost" onClick={clearFilters}>
            {t.clearFilters}
          </Button>
        )}
      </div>

      {logs.isPending && <p className="text-muted" role="status">{tr.common.loading}</p>}

      {logs.isError && !logs.data && (
        <div role="alert" className="space-y-2">
          <p className="text-sm text-destructive">{t.loadError}</p>
          <Button variant="outline" size="sm" onClick={() => logs.refetch()}>
            {tr.common.retry}
          </Button>
        </div>
      )}

      {logs.data && logs.data.total === 0 && (
        <p className="py-8 text-center text-muted">{filtered ? t.emptyFiltered : t.empty}</p>
      )}

      {logs.data && logs.data.total > 0 && (
        <div className={logs.isPlaceholderData ? "opacity-60 transition-opacity" : undefined}>
          <p className="mb-2 text-sm text-muted">{t.total(logs.data.total)}</p>
          <AuditLogTable items={logs.data.items} showDocument showAddress={user?.role === "ADMIN"} />
          {totalPages > 1 && (
            <div className="mt-4 flex justify-center">
              <Pagination page={params.page} totalPages={totalPages} onPageChange={(page) => update({ page })} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
