import type { DocumentStatus, RevisionHistoryItemDto } from "@iso-dms/shared";
import Link from "next/link";
import { DownloadButton } from "@/components/documents/download-button";
import { PdfDownload } from "@/components/documents/pdf-download";
import { RevisionStatusBadge } from "@/components/documents/status-badge";
import { Card } from "@/components/ui/card";
import { downloadPath } from "@/lib/api/endpoints";
import { formatDate } from "@/lib/format";
import { tr } from "@/lib/i18n/tr";

const t = tr.revisions;

const COLUMNS = ["revisionNo", "status", "date", "preparedBy", "approvedBy", "changeSummary", "actions"] as const;

/** The date that matters for a revision: when it went into force, else when it was approved, else created. */
function revisionDate(revision: RevisionHistoryItemDto): string {
  return formatDate(revision.publishedAt ?? revision.approvedAt ?? revision.createdAt);
}

function RevisionActions({
  documentId,
  code,
  revision,
  canRequestPdf,
  previousId,
}: {
  documentId: string;
  code: string;
  revision: RevisionHistoryItemDto;
  canRequestPdf: boolean;
  /** The revision before this one in the history; there is nothing to compare the oldest one with */
  previousId: string | null;
}) {
  const open = revision.canEdit ? tr.detail.edit : tr.detail.view;
  return (
    <span className="inline-flex flex-wrap items-center gap-3">
      <Link
        href={`/documents/${documentId}/edit?revision=${revision.id}`}
        aria-label={`${open} (${t.revision(revision.revisionNo)})`}
        className="text-sm font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-primary"
      >
        {open}
      </Link>
      {previousId && (
        <Link
          href={`/documents/${documentId}/compare?from=${previousId}&to=${revision.id}`}
          aria-label={`${t.compareWithPrevious} (${t.revision(revision.revisionNo)})`}
          className="text-sm font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-primary"
        >
          {t.compareWithPrevious}
        </Link>
      )}
      <DownloadButton
        variant="ghost"
        path={downloadPath.revision(revision.id)}
        fallbackName={`${code} (Rev ${revision.revisionNo})`}
        ariaLabel={`${tr.detail.download} (${t.revision(revision.revisionNo)})`}
      />
      {/* Only a revision that was put in force has (or can get) a PDF copy */}
      {revision.publishedAt !== null && (
        <PdfDownload
          variant="ghost"
          status={revision.pdfStatus}
          path={downloadPath.revisionPdf(revision.id)}
          fallbackName={`${code} (Rev ${revision.revisionNo})`}
          revisionId={revision.id}
          documentId={documentId}
          canRequest={canRequestPdf}
          ariaLabel={`${tr.pdf.download} (${t.revision(revision.revisionNo)})`}
        />
      )}
    </span>
  );
}

export function RevisionHistory({
  documentId,
  code,
  documentStatus,
  revisions,
  canRequestPdf = false,
}: {
  documentId: string;
  code: string;
  documentStatus: DocumentStatus;
  revisions: RevisionHistoryItemDto[];
  /** The user may ask for a PDF copy that is missing */
  canRequestPdf?: boolean;
}) {
  const documentWithdrawn = documentStatus === "WITHDRAWN";
  if (revisions.length === 0) {
    return <p className="text-muted">{t.empty}</p>;
  }

  return (
    <>
      <div className="hidden overflow-x-auto rounded-lg border border-border bg-card md:block">
        <table className="w-full text-left text-sm" aria-label={t.tableLabel}>
          <thead className="border-b border-border bg-accent/60">
            <tr>
              {COLUMNS.map((column) => (
                <th key={column} scope="col" className="px-4 py-3 font-medium whitespace-nowrap">
                  {t.columns[column]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {revisions.map((revision, index) => (
              <tr key={revision.id} className="border-b border-border align-top last:border-0">
                <td className="px-4 py-3 font-medium">{revision.revisionNo}</td>
                <td className="px-4 py-3">
                  <RevisionStatusBadge
                    status={revision.status}
                    isCurrent={revision.isCurrent}
                    documentWithdrawn={documentWithdrawn}
                  />
                </td>
                <td className="px-4 py-3 whitespace-nowrap">{revisionDate(revision)}</td>
                <td className="px-4 py-3">{revision.preparedBy.fullName}</td>
                <td className="px-4 py-3">{revision.approvedBy?.fullName ?? tr.detail.notSet}</td>
                <td className="px-4 py-3">{revision.changeSummary ?? tr.detail.notSet}</td>
                <td className="px-4 py-3">
                  <RevisionActions documentId={documentId} code={code} revision={revision} canRequestPdf={canRequestPdf} previousId={revisions[index + 1]?.id ?? null} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="space-y-3 md:hidden" aria-label={t.tableLabel}>
        {revisions.map((revision, index) => (
          <li key={revision.id}>
            <Card className="space-y-2 p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{t.revision(revision.revisionNo)}</span>
                <RevisionStatusBadge
                    status={revision.status}
                    isCurrent={revision.isCurrent}
                    documentWithdrawn={documentWithdrawn}
                  />
              </div>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                <dt className="text-muted">{t.columns.date}</dt>
                <dd>{revisionDate(revision)}</dd>
                <dt className="text-muted">{t.columns.preparedBy}</dt>
                <dd>{revision.preparedBy.fullName}</dd>
                <dt className="text-muted">{t.columns.approvedBy}</dt>
                <dd>{revision.approvedBy?.fullName ?? tr.detail.notSet}</dd>
                <dt className="text-muted">{t.columns.changeSummary}</dt>
                <dd>{revision.changeSummary ?? tr.detail.notSet}</dd>
              </dl>
              <RevisionActions documentId={documentId} code={code} revision={revision} canRequestPdf={canRequestPdf} previousId={revisions[index + 1]?.id ?? null} />
            </Card>
          </li>
        ))}
      </ul>
    </>
  );
}
