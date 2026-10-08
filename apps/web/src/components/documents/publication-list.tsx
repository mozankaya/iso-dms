"use client";

import { DEFAULT_LIST_PERIOD, DEFAULT_PAGE_SIZE, LIST_PERIODS, type PublicationListItemDto, type PublicationListKind } from "@iso-dms/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { DocumentActions } from "@/components/documents/document-actions";
import { StatusBadge } from "@/components/documents/status-badge";
import { Pagination } from "@/components/pagination";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { getDepartments, getPublicationList } from "@/lib/api/endpoints";
import { useAuth } from "@/lib/auth/auth-context";
import { canViewWithdrawnList } from "@/lib/auth/permissions";
import { formatDate } from "@/lib/format";
import { tr } from "@/lib/i18n/tr";
import {
  hasActivePublicationFilters,
  parsePublicationParams,
  toPublicationQuery,
  toPublicationSearchString,
  type PublicationListParams,
} from "@/lib/lists/list-params";

const SEARCH_DEBOUNCE_MS = 300;

/** The date a list is about: first publication, revision in force, or withdrawal. */
function dateOf(kind: PublicationListKind, item: PublicationListItemDto): string | null {
  if (kind === "new") return item.firstPublishedAt;
  if (kind === "revised") return item.revisedAt;
  return item.withdrawnAt;
}

function TitleCell({ item }: { item: PublicationListItemDto }) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Link href={`/documents/${item.id}`} className="hover:text-primary hover:underline focus-visible:outline-2 focus-visible:outline-primary">
        {item.title}
      </Link>
      {item.status !== "PUBLISHED" && <StatusBadge status={item.status} />}
    </span>
  );
}

/**
 * One of the publication lists (PROJECT.md 9, screen 8): what was published, revised or withdrawn lately. Filters,
 * period and page live in the URL; sorting is fixed (newest first) and happens on the server.
 */
export function PublicationList({ kind }: { kind: PublicationListKind }) {
  const t = tr.lists;
  const labels = t.kinds[kind];
  const { user } = useAuth();
  // Readers never see withdrawn documents: they get a message instead of a request the API would refuse
  const forbidden = kind === "withdrawn" && !canViewWithdrawnList(user?.role);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const params = useMemo(() => parsePublicationParams(searchParams), [searchParams]);

  const [searchText, setSearchText] = useState(params.q);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(debounceTimer.current), []);

  function update(patch: Partial<PublicationListParams>) {
    router.replace(`${pathname}${toPublicationSearchString({ ...params, page: 1, ...patch })}`, { scroll: false });
  }

  function onSearchChange(value: string) {
    setSearchText(value);
    clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => update({ q: value.trim() }), SEARCH_DEBOUNCE_MS);
  }

  function clearFilters() {
    clearTimeout(debounceTimer.current);
    setSearchText("");
    update({ q: "", department: "", period: DEFAULT_LIST_PERIOD });
  }

  const departments = useQuery({ queryKey: ["departments"], queryFn: getDepartments });
  const list = useQuery({
    queryKey: ["documents", "publication", kind, params],
    queryFn: () => getPublicationList(kind, toPublicationQuery(params)),
    placeholderData: keepPreviousData,
    enabled: !forbidden,
  });

  const totalPages = list.data ? Math.max(1, Math.ceil(list.data.total / DEFAULT_PAGE_SIZE)) : 1;
  // A shared link may point past the last page
  const pastLastPage = list.data && !list.isPlaceholderData && params.page > totalPages;
  useEffect(() => {
    if (pastLastPage) router.replace(`${pathname}${toPublicationSearchString({ ...params, page: totalPages })}`, { scroll: false });
  }, [pastLastPage, params, totalPages, pathname, router]);

  const filtered = hasActivePublicationFilters(params);
  const withdrawn = kind === "withdrawn";

  if (forbidden) {
    return (
      <p role="alert" className="text-destructive">
        {t.forbidden}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end">
        <div className="space-y-1.5">
          <Label htmlFor="list-search">{t.searchLabel}</Label>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
            <Input
              id="list-search"
              type="search"
              className="pl-9"
              placeholder={t.searchPlaceholder}
              value={searchText}
              onChange={(event) => onSearchChange(event.target.value)}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="list-department">{t.departmentFilter}</Label>
          <Select id="list-department" value={params.department} onChange={(event) => update({ department: event.target.value })}>
            <option value="">{t.allDepartments}</option>
            {departments.data?.map((department) => (
              <option key={department.id} value={department.id}>
                {department.name}
              </option>
            ))}
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="list-period">{t.period}</Label>
          <Select id="list-period" value={params.period} onChange={(event) => update({ period: event.target.value as PublicationListParams["period"] })}>
            {LIST_PERIODS.map((period) => (
              <option key={period} value={period}>
                {t.periods[period]}
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

      {list.isPending && <p className="text-muted" role="status">{tr.common.loading}</p>}

      {list.isError && !list.data && (
        <div role="alert" className="space-y-2">
          <p className="text-sm text-destructive">{t.loadError}</p>
          <Button variant="outline" size="sm" onClick={() => list.refetch()}>
            {tr.common.retry}
          </Button>
        </div>
      )}

      {list.data && list.data.total === 0 && <p className="py-8 text-center text-muted">{filtered ? t.emptyFiltered : labels.empty}</p>}

      {list.data && list.data.total > 0 && (
        <div className={list.isPlaceholderData ? "opacity-60 transition-opacity" : undefined}>
          <p className="mb-2 text-sm text-muted">{t.total(list.data.total)}</p>

          <div className="hidden overflow-x-auto rounded-lg border border-border bg-card md:block">
            <table className="w-full text-left text-sm" aria-label={t.tableLabel}>
              <thead className="border-b border-border bg-accent/60">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium whitespace-nowrap">{t.columns.code}</th>
                  <th scope="col" className="px-4 py-3 font-medium">{t.columns.title}</th>
                  <th scope="col" className="px-4 py-3 font-medium">{t.columns.department}</th>
                  <th scope="col" className="px-4 py-3 font-medium whitespace-nowrap">{labels.dateColumn}</th>
                  <th scope="col" className="px-4 py-3 font-medium whitespace-nowrap">{t.columns.revisionNo}</th>
                  {withdrawn && <th scope="col" className="px-4 py-3 font-medium">{t.columns.reason}</th>}
                  <th scope="col" className="px-4 py-3 font-medium">{t.columns.actions}</th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((item) => (
                  <tr key={item.id} className="border-b border-border align-top last:border-0">
                    <td className="px-4 py-3">
                      <Link href={`/documents/${item.id}`} className="font-mono text-sm text-primary hover:underline">
                        {item.code}
                      </Link>
                    </td>
                    <td className="px-4 py-3"><TitleCell item={item} /></td>
                    <td className="px-4 py-3">{item.department.name}</td>
                    <td className="px-4 py-3 whitespace-nowrap">{formatDate(dateOf(kind, item))}</td>
                    <td className="px-4 py-3">{item.revisionNo ?? "-"}</td>
                    {withdrawn && <td className="px-4 py-3 break-words">{item.withdrawalReason ?? "-"}</td>}
                    <td className="px-4 py-3"><DocumentActions document={item} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="space-y-3 md:hidden" aria-label={t.tableLabel}>
            {list.data.items.map((item) => (
              <li key={item.id}>
                <Card className="space-y-2 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <Link href={`/documents/${item.id}`} className="font-mono text-sm text-primary hover:underline">
                      {item.code}
                    </Link>
                    <span className="text-xs whitespace-nowrap text-muted">{formatDate(dateOf(kind, item))}</span>
                  </div>
                  <TitleCell item={item} />
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                    <dt className="text-muted">{t.columns.department}</dt>
                    <dd>{item.department.name}</dd>
                    <dt className="text-muted">{t.columns.revisionNo}</dt>
                    <dd>{item.revisionNo ?? "-"}</dd>
                    {withdrawn && (
                      <>
                        <dt className="text-muted">{t.columns.reason}</dt>
                        <dd className="break-words">{item.withdrawalReason ?? "-"}</dd>
                      </>
                    )}
                  </dl>
                  <DocumentActions document={item} />
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
    </div>
  );
}
