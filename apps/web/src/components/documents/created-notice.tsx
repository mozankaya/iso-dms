"use client";

import { X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { tr } from "@/lib/i18n/tr";

/** Success banner shown after a document was created (the code arrives in the `created` URL parameter). */
export function CreatedNotice() {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const code = searchParams.get("created");
  if (!code) return null;

  function dismiss() {
    const next = new URLSearchParams(searchParams.toString());
    next.delete("created");
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  return (
    <div
      role="status"
      className="flex items-start justify-between gap-3 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
    >
      <p>{tr.newDocument.created(code)}</p>
      <Button variant="ghost" size="sm" onClick={dismiss} aria-label={tr.newDocument.dismiss}>
        <X className="h-4 w-4" aria-hidden="true" />
      </Button>
    </div>
  );
}
