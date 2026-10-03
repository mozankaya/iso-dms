"use client";

import {
  DEFAULT_PAGE_SIZE,
  DOCUMENT_SORT_FIELDS,
  DOCUMENT_STATUSES,
  type DocumentSortField,
  type SortOrder,
} from "@iso-dms/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { DocumentCards } from "@/components/documents/document-cards";
import { DocumentTable } from "@/components/documents/document-table";
import { Pagination } from "@/components/pagination";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { getDepartments, getDocuments } from "@/lib/api/endpoints";
import { useAuth } from "@/lib/auth/auth-context";
import {
  hasActiveFilters,
  parseListParams,
  toDocumentQuery,
  toSearchString,
  type ListParams,
} from "@/lib/documents/list-params";
import { tr } from "@/lib/i18n/tr";

const SEARCH_DEBOUNCE_MS = 300;

export function DocumentList({ categoryId }: { categoryId: string }) {
  const { user } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const params = useMemo(() => parseListParams(searchParams), [searchParams]);

  const [searchText, setSearchText] = useState(params.q);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(debounceTimer.current), []);

  function update(patch: Partial<ListParams>) {
    router.replace(`${pathname}${toSearchString({ ...params, page: 1, ...patch })}`, { scroll: false });
  }

  function onSearchChange(value: string) {
    setSearchText(value);
    clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => update({ q: value.trim() }), SEARCH_DEBOUNCE_MS);
  }

  function clearFilters() {
    clearTimeout(debounceTimer.current);
    setSearchText("");
    update({ q: "", department: "", status: "" });
  }

  function sortBy(field: DocumentSortField) {
    const sameField = field === params.sortBy;
    update({ sortBy: field, sortOrder: sameField && params.sortOrder === "asc" ? "desc" : "asc" });
  }

  const departments = useQuery({ queryKey: ["departments"], queryFn: getDepartments });
  const documents = useQuery({
    queryKey: ["documents", categoryId, params],
    queryFn: () => getDocuments(toDocumentQuery(params, categoryId)),
    placeholderData: keepPreviousData,
  });

  const totalPages = documents.data ? Math.max(1, Math.ceil(documents.data.total / DEFAULT_PAGE_SIZE)) : 1;

  // A shared link may point past the last page (documents were removed from the list meanwhile)
  const pastLastPage = documents.data && !documents.isPlaceholderData && params.page > totalPages;
  useEffect(() => {
    if (pastLastPage) {
      router.replace(`${pathname}${toSearchString({ ...params, page: totalPages })}`, { scroll: false });
    }
  }, [pastLastPage, params, totalPages, pathname, router]);

  // Readers only ever receive published documents, so a status filter would be meaningless
  const canFilterByStatus = user !== null && user.role !== "READER";
  const filtered = hasActiveFilters(params);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end">
        <div className="space-y-1.5">
          <Label htmlFor="document-search">{tr.documents.searchLabel}</Label>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
            <Input
              id="document-search"
              type="search"
              className="pl-9"
              placeholder={tr.documents.searchPlaceholder}
              value={searchText}
              onChange={(event) => onSearchChange(event.target.value)}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="department-filter">{tr.documents.departmentFilter}</Label>
          <Select
            id="department-filter"
            value={params.department}
            onChange={(event) => update({ department: event.target.value })}
          >
            <option value="">{tr.documents.allDepartments}</option>
            {departments.data?.map((department) => (
              <option key={department.id} value={department.id}>
                {department.name}
              </option>
            ))}
          </Select>
        </div>

        {canFilterByStatus ? (
          <div className="space-y-1.5">
            <Label htmlFor="status-filter">{tr.documents.statusFilter}</Label>
            <Select
              id="status-filter"
              value={params.status}
              onChange={(event) => update({ status: event.target.value as ListParams["status"] })}
            >
              <option value="">{tr.documents.allStatuses}</option>
              {DOCUMENT_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {tr.documents.status[status]}
                </option>
              ))}
            </Select>
          </div>
        ) : (
          <div className="hidden lg:block" />
        )}

        <div className="space-y-1.5 md:hidden">
          <Label htmlFor="sort-select">{tr.documents.sortLabel}</Label>
          <Select
            id="sort-select"
            value={`${params.sortBy}:${params.sortOrder}`}
            onChange={(event) => {
              const [field, order] = event.target.value.split(":") as [DocumentSortField, SortOrder];
              update({ sortBy: field, sortOrder: order });
            }}
          >
            {DOCUMENT_SORT_FIELDS.flatMap((field) =>
              (["asc", "desc"] as const).map((order) => (
                <option key={`${field}:${order}`} value={`${field}:${order}`}>
                  {tr.documents.columns[field]} ({order === "asc" ? tr.documents.ascending : tr.documents.descending})
                </option>
              )),
            )}
          </Select>
        </div>

        {filtered && (
          <Button variant="ghost" onClick={clearFilters}>
            {tr.documents.clearFilters}
          </Button>
        )}
      </div>

      {documents.isPending && <p className="text-muted" role="status">{tr.common.loading}</p>}

      {documents.isError && !documents.data && (
        <div role="alert" className="space-y-2">
          <p className="text-sm text-destructive">{tr.documents.error}</p>
          <Button variant="outline" size="sm" onClick={() => documents.refetch()}>
            {tr.common.retry}
          </Button>
        </div>
      )}

      {documents.data && documents.data.total === 0 && (
        <p className="py-8 text-center text-muted">
          {filtered ? tr.documents.emptyFiltered : tr.documents.empty}
        </p>
      )}

      {documents.data && documents.data.total > 0 && (
        <div className={documents.isPlaceholderData ? "opacity-60 transition-opacity" : undefined}>
          <p className="mb-2 text-sm text-muted">{tr.documents.total(documents.data.total)}</p>
          <div className="hidden md:block">
            <DocumentTable
              data={documents.data.items}
              sortBy={params.sortBy}
              sortOrder={params.sortOrder}
              onSort={sortBy}
            />
          </div>
          <div className="md:hidden">
            <DocumentCards data={documents.data.items} />
          </div>
          {totalPages > 1 && (
            <div className="mt-4 flex justify-center">
              <Pagination
                page={params.page}
                totalPages={totalPages}
                onPageChange={(page) => update({ page })}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
