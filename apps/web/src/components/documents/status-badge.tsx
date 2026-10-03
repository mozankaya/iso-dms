import type { DocumentStatus } from "@iso-dms/shared";
import { tr } from "@/lib/i18n/tr";
import { cn } from "@/lib/utils";

const STYLES: Record<DocumentStatus, string> = {
  DRAFT: "bg-slate-100 text-slate-700",
  IN_REVIEW: "bg-amber-100 text-amber-800",
  PUBLISHED: "bg-emerald-100 text-emerald-800",
  WITHDRAWN: "bg-red-100 text-red-800",
};

export function StatusBadge({ status }: { status: DocumentStatus }) {
  return (
    <span className={cn("inline-block rounded-full px-2 py-0.5 text-xs font-medium", STYLES[status])}>
      {tr.documents.status[status]}
    </span>
  );
}
