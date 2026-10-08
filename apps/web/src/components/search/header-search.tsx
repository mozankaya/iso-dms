"use client";

import { SEARCH_QUERY_MAX_LENGTH } from "@iso-dms/shared";
import { Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { isSearchable, toSearchString, DEFAULT_SEARCH_PARAMS } from "@/lib/search/search-params";
import { tr } from "@/lib/i18n/tr";

const t = tr.search;

/** The search box of the header: sends the words to the search page. */
export function HeaderSearch() {
  const router = useRouter();
  const [text, setText] = useState("");

  function submit(event: FormEvent) {
    event.preventDefault();
    const q = text.trim();
    if (!isSearchable(q)) return;
    router.push(`/search${toSearchString({ ...DEFAULT_SEARCH_PARAMS, q })}`);
  }

  return (
    <form role="search" onSubmit={submit} className="relative mx-2 min-w-0 flex-1 md:max-w-md">
      <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
      <input
        type="search"
        aria-label={t.inputLabel}
        placeholder={t.inputPlaceholder}
        maxLength={SEARCH_QUERY_MAX_LENGTH}
        value={text}
        onChange={(event) => setText(event.target.value)}
        className="h-9 w-full rounded-md border border-border bg-background pr-3 pl-9 text-sm focus-visible:outline-2 focus-visible:outline-primary"
      />
    </form>
  );
}
