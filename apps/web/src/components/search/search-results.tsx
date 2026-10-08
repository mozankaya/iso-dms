"use client";

import { DEFAULT_PAGE_SIZE, SEARCH_MAX_RESULTS, SEARCH_QUERY_MAX_LENGTH, type SearchResultDto } from "@iso-dms/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
import { Pagination } from "@/components/pagination";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { ApiError } from "@/lib/api/client";
import { getCategories, getDepartments, searchDocuments } from "@/lib/api/endpoints";
import { errorMessage, tr } from "@/lib/i18n/tr";
import {
  hasActiveSearchFilters,
  isSearchable,
  parseSearchParams,
  toSearchQuery,
  toSearchString,
  type SearchParams,
} from "@/lib/search/search-params";
import { cn } from "@/lib/utils";

const t = tr.search;

function Snippet({ parts }: { parts: SearchResultDto["snippets"][number] }) {
  return (
    <p className="text-sm text-muted">
      {parts.map((part, index) =>
        part.match ? (
          <mark key={index} className="rounded-sm bg-amber-100 px-0.5 font-medium text-foreground">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </p>
  );
}

function Result({ item }: { item: SearchResultDto }) {
  return (
    <li>
      <Card className="space-y-2 p-4">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <Link href={`/documents/${item.id}`} className="font-mono text-sm text-primary hover:underline">
            {item.code}
          </Link>
          <Link href={`/documents/${item.id}`} className="font-medium hover:underline">
            {item.title}
          </Link>
          <span className="text-sm text-muted">{item.department.name}</span>
        </div>
        {item.snippets.length > 0 ? (
          <ul aria-label={t.matchLabel} className="space-y-1">
            {item.snippets.map((parts, index) => (
              <li key={index}>
                <Snippet parts={parts} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted">{t.titleOrCodeOnly}</p>
        )}
      </Card>
    </li>
  );
}

function SearchForm({ initial, onSearch }: { initial: string; onSearch: (q: string) => void }) {
  const [text, setText] = useState(initial);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (isSearchable(text)) onSearch(text.trim());
  }

  return (
    <form onSubmit={submit} role="search" className="flex gap-2">
      <div className="relative flex-1">
        <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
        <Input
          type="search"
          aria-label={t.wordsLabel}
          placeholder={t.inputPlaceholder}
          maxLength={SEARCH_QUERY_MAX_LENGTH}
          className="pl-9"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </div>
      <Button type="submit" disabled={!isSearchable(text)}>
        {t.submit}
      </Button>
    </form>
  );
}

/** Full text search over the documents in force (PROJECT.md 6.16). The words and filters live in the address. */
export function SearchResults() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const params = useMemo(() => parseSearchParams(searchParams), [searchParams]);

  function update(patch: Partial<SearchParams>) {
    router.replace(`${pathname}${toSearchString({ ...params, page: 1, ...patch })}`, { scroll: false });
  }

  const departments = useQuery({ queryKey: ["departments"], queryFn: getDepartments });
  const categories = useQuery({ queryKey: ["categories"], queryFn: getCategories });
  const enabled = isSearchable(params.q);
  const results = useQuery({
    queryKey: ["search", params],
    queryFn: () => searchDocuments(toSearchQuery(params)),
    placeholderData: keepPreviousData,
    enabled,
    retry: false,
  });

  const totalPages = results.data ? Math.max(1, Math.ceil(results.data.total / DEFAULT_PAGE_SIZE)) : 1;
  const filtered = hasActiveSearchFilters(params);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">{t.description}</p>

      {/* Keyed by the words in the address: a new search from the header refills the box */}
      <SearchForm key={params.q} initial={params.q} onSearch={(q) => update({ q })} />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end">
        <div className="space-y-1.5">
          <Label htmlFor="search-department">{t.departmentFilter}</Label>
          <Select id="search-department" value={params.department} onChange={(event) => update({ department: event.target.value })}>
            <option value="">{t.allDepartments}</option>
            {departments.data?.map((department) => (
              <option key={department.id} value={department.id}>
                {department.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="search-category">{t.categoryFilter}</Label>
          <Select id="search-category" value={params.category} onChange={(event) => update({ category: event.target.value })}>
            <option value="">{t.allCategories}</option>
            {categories.data?.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </Select>
        </div>
        {filtered && (
          <Button variant="ghost" onClick={() => update({ department: "", category: "" })}>
            {t.clearFilters}
          </Button>
        )}
      </div>

      {!enabled && <p className="py-8 text-center text-muted">{params.q ? t.minLength(2) : t.start}</p>}

      {enabled && results.isPending && (
        <p className="text-muted" role="status">
          {tr.common.loading}
        </p>
      )}
      {enabled && results.isError && !results.data && (
        <div role="alert" className="space-y-2">
          <p className="text-sm text-destructive">{results.error instanceof ApiError ? errorMessage(results.error) : t.loadError}</p>
          <Button variant="outline" size="sm" onClick={() => results.refetch()}>
            {tr.common.retry}
          </Button>
        </div>
      )}
      {enabled && results.data && results.data.total === 0 && <p className="py-8 text-center text-muted">{t.empty}</p>}

      {enabled && results.data && results.data.total > 0 && (
        <div className={cn("space-y-4", results.isPlaceholderData && "opacity-60 transition-opacity")}>
          <p className="text-sm text-muted" role="status">
            {t.total(results.data.total)}
            {results.data.total >= SEARCH_MAX_RESULTS && ` · ${t.capped(SEARCH_MAX_RESULTS)}`}
          </p>
          <ul aria-label={t.resultsLabel} className="space-y-3">
            {results.data.items.map((item) => (
              <Result key={item.id} item={item} />
            ))}
          </ul>
          {totalPages > 1 && <Pagination page={params.page} totalPages={totalPages} onPageChange={(page) => update({ page })} />}
        </div>
      )}
    </div>
  );
}
