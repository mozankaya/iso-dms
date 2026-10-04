import type { DocumentListItemDto } from "@iso-dms/shared";
import Link from "next/link";
import { tr } from "@/lib/i18n/tr";

/** Opens the document in the editor screen: editable for people who may edit it, read only otherwise. */
export function DocumentActionLink({ document }: { document: Pick<DocumentListItemDto, "id" | "canEdit"> }) {
  return (
    <Link
      href={`/documents/${document.id}/edit`}
      className="inline-flex text-sm font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-primary"
    >
      {document.canEdit ? tr.documents.actions.edit : tr.documents.actions.view}
    </Link>
  );
}
