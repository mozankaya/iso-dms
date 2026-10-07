import type { AuditLogDto } from "@iso-dms/shared";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { actionLabel, describeEntry } from "@/lib/audit/describe";
import { formatDateTime } from "@/lib/format";
import { tr } from "@/lib/i18n/tr";

const t = tr.audit;

interface Props {
  items: AuditLogDto[];
  /** The document column is redundant on a document's own history */
  showDocument: boolean;
  /** Only administrators receive addresses */
  showAddress: boolean;
}

function UserCell({ entry }: { entry: AuditLogDto }) {
  if (!entry.user) return <span className="text-muted">{t.noUser}</span>;
  return (
    <span className="block">
      {entry.user.fullName}
      <span className="block text-xs text-muted">{entry.user.email}</span>
    </span>
  );
}

function DocumentCell({ entry }: { entry: AuditLogDto }) {
  if (!entry.document) return <span className="text-muted">-</span>;
  return (
    <Link
      href={`/documents/${entry.document.id}`}
      className="font-mono text-sm text-primary hover:underline focus-visible:outline-2 focus-visible:outline-primary"
    >
      {entry.document.code}
      {entry.document.revisionNo !== null && <span className="ml-1.5 font-sans text-muted">{t.revision(entry.document.revisionNo)}</span>}
    </Link>
  );
}

export function AuditLogTable({ items, showDocument, showAddress }: Props) {
  return (
    <>
      <div className="hidden overflow-x-auto rounded-lg border border-border bg-card md:block">
        <table className="w-full text-left text-sm" aria-label={t.tableLabel}>
          <thead className="border-b border-border bg-accent/60">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium whitespace-nowrap">{t.columns.date}</th>
              <th scope="col" className="px-4 py-3 font-medium">{t.columns.user}</th>
              <th scope="col" className="px-4 py-3 font-medium">{t.columns.action}</th>
              {showDocument && <th scope="col" className="px-4 py-3 font-medium">{t.columns.document}</th>}
              <th scope="col" className="px-4 py-3 font-medium">{t.columns.details}</th>
              {showAddress && <th scope="col" className="px-4 py-3 font-medium whitespace-nowrap">{t.columns.ipAddress}</th>}
            </tr>
          </thead>
          <tbody>
            {items.map((entry) => (
              <tr key={entry.id} className="border-b border-border align-top last:border-0">
                <td className="px-4 py-3 whitespace-nowrap">{formatDateTime(entry.createdAt)}</td>
                <td className="px-4 py-3"><UserCell entry={entry} /></td>
                <td className="px-4 py-3 font-medium">{actionLabel(entry.action)}</td>
                {showDocument && <td className="px-4 py-3 whitespace-nowrap"><DocumentCell entry={entry} /></td>}
                <td className="px-4 py-3">{describeEntry(entry) || <span className="text-muted">-</span>}</td>
                {showAddress && <td className="px-4 py-3 font-mono text-xs whitespace-nowrap">{entry.ipAddress ?? "-"}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="space-y-3 md:hidden" aria-label={t.tableLabel}>
        {items.map((entry) => (
          <li key={entry.id}>
            <Card className="space-y-2 p-4">
              <div className="flex items-start justify-between gap-2">
                <span className="font-medium">{actionLabel(entry.action)}</span>
                <span className="text-xs whitespace-nowrap text-muted">{formatDateTime(entry.createdAt)}</span>
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                <dt className="text-muted">{t.columns.user}</dt>
                <dd><UserCell entry={entry} /></dd>
                {showDocument && (
                  <>
                    <dt className="text-muted">{t.columns.document}</dt>
                    <dd><DocumentCell entry={entry} /></dd>
                  </>
                )}
                <dt className="text-muted">{t.columns.details}</dt>
                <dd>{describeEntry(entry) || "-"}</dd>
                {showAddress && (
                  <>
                    <dt className="text-muted">{t.columns.ipAddress}</dt>
                    <dd className="font-mono text-xs">{entry.ipAddress ?? "-"}</dd>
                  </>
                )}
              </dl>
            </Card>
          </li>
        ))}
      </ul>
    </>
  );
}
