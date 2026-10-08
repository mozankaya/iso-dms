"use client";

import { DEFAULT_PAGE_SIZE, FEEDBACK_STATUS_FILTERS, LIST_PERIODS, type FeedbackDto } from "@iso-dms/shared";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ResolveFeedbackDialog } from "@/components/feedback/resolve-feedback-dialog";
import { Pagination } from "@/components/pagination";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { ApiError } from "@/lib/api/client";
import { getDepartments, getFeedback, reopenFeedback } from "@/lib/api/endpoints";
import { useAuth } from "@/lib/auth/auth-context";
import { canReadFeedback } from "@/lib/auth/permissions";
import {
  hasActiveFeedbackFilters,
  parseFeedbackParams,
  toFeedbackQuery,
  toFeedbackSearchString,
  type FeedbackListParams,
} from "@/lib/feedback/list-params";
import { formatDate, formatDateTime } from "@/lib/format";
import { errorMessage, tr } from "@/lib/i18n/tr";

const t = tr.feedback.page;
const SEARCH_DEBOUNCE_MS = 300;

function DocumentCell({ feedback }: { feedback: FeedbackDto }) {
  return (
    <span className="block">
      <Link href={`/documents/${feedback.document.id}`} className="font-mono text-sm text-primary hover:underline">
        {feedback.document.code}
        {feedback.revisionNo !== null && <span className="ml-1.5 font-sans text-muted">{tr.audit.revision(feedback.revisionNo)}</span>}
      </Link>
      <span className="block text-sm">{feedback.document.title}</span>
    </span>
  );
}

function StatusCell({ feedback }: { feedback: FeedbackDto }) {
  if (!feedback.isResolved) {
    return <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">{t.open}</span>;
  }
  return (
    <span className="block space-y-0.5">
      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">{t.statuses.resolved}</span>
      {feedback.resolvedBy && feedback.resolvedAt && (
        <span className="block text-xs text-muted">{t.resolvedBy(feedback.resolvedBy.fullName, formatDate(feedback.resolvedAt))}</span>
      )}
      {feedback.resolutionNote && (
        <span className="block text-sm break-words">
          <span className="text-muted">{t.note}: </span>
          {feedback.resolutionNote}
        </span>
      )}
    </span>
  );
}

/** The feedback sent about documents, for the quality managers and administrators (PROJECT.md 6.8). */
export function FeedbackList() {
  const { user } = useAuth();
  const allowed = canReadFeedback(user?.role);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const params = useMemo(() => parseFeedbackParams(searchParams), [searchParams]);

  const [searchText, setSearchText] = useState(params.q);
  const [closing, setClosing] = useState<FeedbackDto | null>(null);
  const [reopenError, setReopenError] = useState<string | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(debounceTimer.current), []);

  function update(patch: Partial<FeedbackListParams>) {
    router.replace(`${pathname}${toFeedbackSearchString({ ...params, page: 1, ...patch })}`, { scroll: false });
  }

  function onSearchChange(value: string) {
    setSearchText(value);
    clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => update({ q: value.trim() }), SEARCH_DEBOUNCE_MS);
  }

  function clearFilters() {
    clearTimeout(debounceTimer.current);
    setSearchText("");
    update({ q: "", department: "", status: "open", period: "all" });
  }

  const departments = useQuery({ queryKey: ["departments"], queryFn: getDepartments, enabled: allowed });
  const feedback = useQuery({
    queryKey: ["feedback", params],
    queryFn: () => getFeedback(toFeedbackQuery(params)),
    placeholderData: keepPreviousData,
    enabled: allowed,
  });

  const reopen = useMutation({ mutationFn: (id: string) => reopenFeedback(id) });
  async function reopenOne(item: FeedbackDto) {
    setReopenError(null);
    try {
      await reopen.mutateAsync(item.id);
    } catch (caught) {
      setReopenError(caught instanceof ApiError ? errorMessage(caught) : tr.errors.NETWORK);
    }
    await Promise.all(["feedback", "dashboard-stats", "audit-logs"].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
  }

  const totalPages = feedback.data ? Math.max(1, Math.ceil(feedback.data.total / DEFAULT_PAGE_SIZE)) : 1;
  const pastLastPage = feedback.data && !feedback.isPlaceholderData && params.page > totalPages;
  useEffect(() => {
    if (pastLastPage) router.replace(`${pathname}${toFeedbackSearchString({ ...params, page: totalPages })}`, { scroll: false });
  }, [pastLastPage, params, totalPages, pathname, router]);

  if (!allowed) {
    return (
      <p role="alert" className="text-destructive">
        {t.forbidden}
      </p>
    );
  }

  const filtered = hasActiveFeedbackFilters(params);
  const actions = (item: FeedbackDto) =>
    item.isResolved ? (
      <Button size="sm" variant="outline" disabled={reopen.isPending} onClick={() => reopenOne(item)}>
        {reopen.isPending && reopen.variables === item.id ? t.reopening : t.reopen}
      </Button>
    ) : (
      <Button size="sm" onClick={() => setClosing(item)}>
        {t.resolve}
      </Button>
    );

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end">
        <div className="space-y-1.5">
          <Label htmlFor="feedback-search">{t.searchLabel}</Label>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
            <Input
              id="feedback-search"
              type="search"
              className="pl-9"
              placeholder={t.searchPlaceholder}
              value={searchText}
              onChange={(event) => onSearchChange(event.target.value)}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="feedback-status">{t.statusFilter}</Label>
          <Select id="feedback-status" value={params.status} onChange={(event) => update({ status: event.target.value as FeedbackListParams["status"] })}>
            {FEEDBACK_STATUS_FILTERS.map((status) => (
              <option key={status} value={status}>
                {t.statuses[status]}
              </option>
            ))}
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="feedback-department">{t.departmentFilter}</Label>
          <Select id="feedback-department" value={params.department} onChange={(event) => update({ department: event.target.value })}>
            <option value="">{t.allDepartments}</option>
            {departments.data?.map((department) => (
              <option key={department.id} value={department.id}>
                {department.name}
              </option>
            ))}
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="feedback-period">{t.period}</Label>
          <Select id="feedback-period" value={params.period} onChange={(event) => update({ period: event.target.value as FeedbackListParams["period"] })}>
            {LIST_PERIODS.map((period) => (
              <option key={period} value={period}>
                {tr.lists.periods[period]}
              </option>
            ))}
          </Select>
        </div>

        {filtered && (
          <Button variant="ghost" onClick={clearFilters}>
            {t.clearFilters}
          </Button>
        )}
      </div>

      {reopenError && (
        <p role="alert" className="text-sm text-destructive">
          {reopenError}
        </p>
      )}

      {feedback.isPending && <p className="text-muted" role="status">{tr.common.loading}</p>}

      {feedback.isError && !feedback.data && (
        <div role="alert" className="space-y-2">
          <p className="text-sm text-destructive">{t.loadError}</p>
          <Button variant="outline" size="sm" onClick={() => feedback.refetch()}>
            {tr.common.retry}
          </Button>
        </div>
      )}

      {feedback.data && feedback.data.total === 0 && (
        <p className="py-8 text-center text-muted">{filtered ? t.emptyFiltered : params.status === "open" ? t.emptyOpen : t.empty}</p>
      )}

      {feedback.data && feedback.data.total > 0 && (
        <div className={feedback.isPlaceholderData ? "opacity-60 transition-opacity" : undefined}>
          <p className="mb-2 text-sm text-muted">{t.total(feedback.data.total)}</p>

          <div className="hidden overflow-x-auto rounded-lg border border-border bg-card md:block">
            <table className="w-full text-left text-sm" aria-label={t.tableLabel}>
              <thead className="border-b border-border bg-accent/60">
                <tr>
                  {(["date", "sender", "document", "message", "status", "actions"] as const).map((column) => (
                    <th key={column} scope="col" className="px-4 py-3 font-medium whitespace-nowrap">
                      {t.columns[column]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {feedback.data.items.map((item) => (
                  <tr key={item.id} className="border-b border-border align-top last:border-0">
                    <td className="px-4 py-3 whitespace-nowrap">{formatDateTime(item.createdAt)}</td>
                    <td className="px-4 py-3">
                      {item.user.fullName}
                      {item.user.department && <span className="block text-xs text-muted">{item.user.department.name}</span>}
                    </td>
                    <td className="px-4 py-3"><DocumentCell feedback={item} /></td>
                    <td className="max-w-md px-4 py-3 break-words whitespace-pre-wrap">{item.message}</td>
                    <td className="px-4 py-3"><StatusCell feedback={item} /></td>
                    <td className="px-4 py-3 whitespace-nowrap">{actions(item)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="space-y-3 md:hidden" aria-label={t.tableLabel}>
            {feedback.data.items.map((item) => (
              <li key={item.id}>
                <Card className="space-y-2 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <DocumentCell feedback={item} />
                    <span className="text-xs whitespace-nowrap text-muted">{formatDateTime(item.createdAt)}</span>
                  </div>
                  <p className="text-sm break-words whitespace-pre-wrap">{item.message}</p>
                  <p className="text-xs text-muted">
                    {item.user.fullName}
                    {item.user.department && ` · ${item.user.department.name}`}
                  </p>
                  <StatusCell feedback={item} />
                  <div>{actions(item)}</div>
                </Card>
              </li>
            ))}
          </ul>

          {totalPages > 1 && (
            <div className="mt-4 flex justify-center">
              <Pagination page={params.page} totalPages={totalPages} onPageChange={(page) => update({ page })} />
            </div>
          )}
        </div>
      )}

      <ResolveFeedbackDialog feedback={closing} onClose={() => setClosing(null)} />
    </div>
  );
}
