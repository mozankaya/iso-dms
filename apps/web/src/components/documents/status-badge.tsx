import type { DocumentStatus, RevisionStatus } from "@iso-dms/shared";
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

const REVISION_STYLES = {
  DRAFT: "bg-slate-100 text-slate-700",
  IN_REVIEW: "bg-amber-100 text-amber-800",
  APPROVED: "bg-sky-100 text-sky-800",
  CURRENT: "bg-emerald-100 text-emerald-800",
  REJECTED: "bg-orange-100 text-orange-800",
  SUPERSEDED: "bg-red-100 text-red-800",
} as const;

/**
 * Status of one revision; the revision in force is shown as "Yürürlükte", replaced ones as "GEÇERSİZ".
 * When the whole document was withdrawn, its approved revisions are invalid too.
 */
export function RevisionStatusBadge({
  status,
  isCurrent,
  documentWithdrawn = false,
}: {
  status: RevisionStatus;
  isCurrent: boolean;
  documentWithdrawn?: boolean;
}) {
  const key = status === "APPROVED" ? (documentWithdrawn ? "SUPERSEDED" : isCurrent ? "CURRENT" : "APPROVED") : status;
  return (
    <span className={cn("inline-block rounded-full px-2 py-0.5 text-xs font-medium", REVISION_STYLES[key])}>
      {tr.revisions.status[key]}
    </span>
  );
}
