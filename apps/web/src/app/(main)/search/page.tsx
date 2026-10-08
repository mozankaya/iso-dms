import { Suspense } from "react";
import { SearchResults } from "@/components/search/search-results";
import { tr } from "@/lib/i18n/tr";

export default function SearchPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">{tr.search.title}</h1>
      <Suspense fallback={<p className="text-muted">{tr.common.loading}</p>}>
        <SearchResults />
      </Suspense>
    </div>
  );
}
