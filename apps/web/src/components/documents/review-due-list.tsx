"use client";

import { DEFAULT_PAGE_SIZE, REVIEW_DUE_WINDOW_DAYS } from "@iso-dms/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pagination } from "@/components/pagination";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { getDepartments, getReviewDueList } from "@/lib/api/endpoints";
import { useAuth } from "@/lib/auth/auth-context";
import { formatDate } from "@/lib/format";
import { tr } from "@/lib/i18n/tr";
import {
  hasActiveReviewDueFilters,
  parseReviewDueParams,
  toReviewDueQuery,
  toReviewDueSearchString,
  type ReviewDueParams,
} from "@/lib/lists/review-params";
import { cn } from "@/lib/utils";

const t = tr.reviewDue;
const SEARCH_DEBOUNCE_MS = 300;

/** The documents whose periodic review is the user's to do and is due soon or overdue (PROJECT.md 6.5). */
export function ReviewDueList() {
  const { user } = useAuth();
  // Readers have no reviews: a message instead of a request the API would refuse
  const forbidden = user?.role === "READER";
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const params = useMemo(() => parseReviewDueParams(searchParams), [searchParams]);
  const [searchText, setSearchText] = useState(params.q);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(debounceTimer.current), []);

  function update(patch: Partial<ReviewDueParams>) {
    router.replace(`${pathname}${toReviewDueSearchString({ ...params, page: 1, ...patch })}`, { scroll: false });
  }

  function onSearchChange(value: string) {
    setSearchText(value);
    clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => update({ q: value.trim() }), SEARCH_DEBOUNCE_MS);
  }

  function clearFilters() {
    clearTimeout(debounceTimer.current);
    setSearchText("");
    update({ q: "", department: "" });
  }

  const departments = useQuery({ queryKey: ["departments"], queryFn: getDepartments, enabled: !forbidden });
  const list = useQuery({
    queryKey: ["review-due", params],
    queryFn: () => getReviewDueList(toReviewDueQuery(params)),
    placeholderData: keepPreviousData,
    enabled: !forbidden,
  });

  const totalPages = list.data ? Math.max(1, Math.ceil(list.data.total / DEFAULT_PAGE_SIZE)) : 1;
  const pastLastPage = list.data && !list.isPlaceholderData && params.page > totalPages;
  useEffect(() => {
    if (pastLastPage) router.replace(`${pathname}${toReviewDueSearchString({ ...params, page: totalPages })}`, { scroll: false });
  }, [pastLastPage, params, totalPages, pathname, router]);

  if (forbidden) {
    return (
      <p role="alert" className="text-destructive">
        {t.forbidden}
      </p>
    );
  }

  const filtered = hasActiveReviewDueFilters(params);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">{t.window(REVIEW_DUE_WINDOW_DAYS)}</p>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto] lg:items-end">
        <div className="space-y-1.5">
          <Label htmlFor="review-search">{t.searchLabel}</Label>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
            <Input id="review-search" type="search" className="pl-9" placeholder={t.searchPlaceholder} value={searchText} onChange={(event) => onSearchChange(event.target.value)} />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="review-department">{t.departmentFilter}</Label>
          <Select id="review-department" value={params.department} onChange={(event) => update({ department: event.target.value })}>
            <option value="">{t.allDepartments}</option>
            {departments.data?.map((department) => (
              <option key={department.id} value={department.id}>
                {department.name}
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

      {list.isPending && (
        <p className="text-muted" role="status">
          {tr.common.loading}
        </p>
      )}
      {list.isError && !list.data && (
        <div role="alert" className="space-y-2">
          <p className="text-sm text-destructive">{t.loadError}</p>
          <Button variant="outline" size="sm" onClick={() => list.refetch()}>
            {tr.common.retry}
          </Button>
        </div>
      )}
      {list.data && list.data.total === 0 && <p className="py-8 text-center text-muted">{filtered ? t.emptyFiltered : t.empty}</p>}

      {list.data && list.data.total > 0 && (
        <div className={cn("space-y-4", list.isPlaceholderData && "opacity-60 transition-opacity")}>
          <p className="text-sm text-muted">{t.total(list.data.total)}</p>
          <Card className="overflow-x-auto">
            <table className="w-full text-left text-sm" aria-label={t.tableLabel}>
              <thead className="border-b border-border bg-accent/60">
                <tr>
                  {(["code", "title", "department", "owner", "nextReviewAt"] as const).map((column) => (
                    <th key={column} scope="col" className="px-4 py-3 font-medium whitespace-nowrap">
                      {t.columns[column]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((item) => (
                  <tr key={item.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-3 font-mono whitespace-nowrap">
                      <Link href={`/documents/${item.id}`} className="text-primary hover:underline">
                        {item.code}
                      </Link>
                    </td>
                    <td className="px-4 py-3">{item.title}</td>
                    <td className="px-4 py-3">{item.department.name}</td>
                    <td className="px-4 py-3">{item.owner.fullName}</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {formatDate(item.nextReviewAt)}
                      {item.overdue && <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">{t.overdue}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          {totalPages > 1 && <Pagination page={params.page} totalPages={totalPages} onPageChange={(page) => update({ page })} />}
        </div>
      )}
    </div>
  );
}
