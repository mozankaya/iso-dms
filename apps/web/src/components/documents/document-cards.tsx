import type { DocumentListItemDto } from "@iso-dms/shared";
import { DocumentActionLink } from "@/components/documents/document-action-link";
import { StatusBadge } from "@/components/documents/status-badge";
import { Card } from "@/components/ui/card";
import { formatDate } from "@/lib/format";
import { tr } from "@/lib/i18n/tr";

/** Mobile layout of the document list. */
export function DocumentCards({ data }: { data: DocumentListItemDto[] }) {
  return (
    <ul className="space-y-3" aria-label={tr.documents.tableLabel}>
      {data.map((document) => (
        <li key={document.id}>
          <Card className="space-y-2 p-4">
            <div className="flex items-start justify-between gap-2">
              <span className="font-mono text-sm text-muted">{document.code}</span>
              {document.status !== "PUBLISHED" && <StatusBadge status={document.status} />}
            </div>
            <p className="font-medium">{document.title}</p>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted">{tr.documents.columns.department}</dt>
              <dd>{document.department.name}</dd>
              <dt className="text-muted">{tr.documents.columns.firstPublishedAt}</dt>
              <dd>{formatDate(document.firstPublishedAt)}</dd>
              <dt className="text-muted">{tr.documents.columns.revisedAt}</dt>
              <dd>{formatDate(document.revisedAt)}</dd>
              <dt className="text-muted">{tr.documents.columns.revisionNo}</dt>
              <dd>{document.revisionNo ?? "-"}</dd>
            </dl>
            <DocumentActionLink document={document} />
          </Card>
        </li>
      ))}
    </ul>
  );
}
