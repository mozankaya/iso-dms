import type { DocumentListItemDto } from "@iso-dms/shared";
import Link from "next/link";
import { DownloadButton } from "@/components/documents/download-button";
import { downloadPath } from "@/lib/api/endpoints";
import { tr } from "@/lib/i18n/tr";

/**
 * Row actions of the document list. "Düzenle"/"Görüntüle" opens the editor screen (the API decides the
 * mode); "İndir" is offered when a revision is in force (a withdrawn document has none), which is what the
 * download endpoint serves.
 */
export function DocumentActions({
  document,
}: {
  document: Pick<DocumentListItemDto, "id" | "code" | "canEdit" | "revisionNo" | "status">;
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-3">
      <Link
        href={`/documents/${document.id}/edit`}
        className="text-sm font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-primary"
      >
        {document.canEdit ? tr.documents.actions.edit : tr.documents.actions.view}
      </Link>
      {document.revisionNo !== null && document.status !== "WITHDRAWN" && (
        <DownloadButton
          variant="ghost"
          path={downloadPath.current(document.id)}
          fallbackName={document.code}
          ariaLabel={`${tr.detail.download} (${document.code})`}
        />
      )}
    </span>
  );
}
