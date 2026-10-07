"use client";

import { DEFAULT_PAGE_SIZE, type PendingApprovalDto } from "@iso-dms/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { DecisionDialog, type DecisionTarget } from "@/components/documents/decision-dialog";
import { Pagination } from "@/components/pagination";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { getPendingApprovals } from "@/lib/api/endpoints";
import { formatDateTime } from "@/lib/format";
import { tr } from "@/lib/i18n/tr";

const t = tr.approvals;

function ItemActions({ item, onDecide }: { item: PendingApprovalDto; onDecide: (target: DecisionTarget) => void }) {
  const target = (mode: DecisionTarget["mode"]): DecisionTarget => ({
    stepId: item.stepId,
    mode,
    documentId: item.document.id,
    code: item.document.code,
    revisionNo: item.revision.revisionNo,
  });
  const label = `${item.document.code} ${tr.approval.revision(item.revision.revisionNo)}`;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Link
        href={`/documents/${item.document.id}/edit?revision=${item.revision.id}`}
        aria-label={`${tr.approval.review} (${label})`}
        className={buttonVariants({ variant: "outline", size: "sm" })}
      >
        {tr.approval.review}
      </Link>
      <Button size="sm" aria-label={`${tr.approval.approve} (${label})`} onClick={() => onDecide(target("approve"))}>
        {tr.approval.approve}
      </Button>
      <Button size="sm" variant="outline" aria-label={`${tr.approval.reject} (${label})`} onClick={() => onDecide(target("reject"))}>
        {tr.approval.reject}
      </Button>
    </span>
  );
}

function DocumentCell({ item }: { item: PendingApprovalDto }) {
  return (
    <span className="block">
      <Link href={`/documents/${item.document.id}`} className="font-mono text-sm text-primary hover:underline">
        {item.document.code}
      </Link>
      <span className="block">{item.document.title}</span>
      <span className="block text-xs text-muted">{item.document.department.name}</span>
    </span>
  );
}

/** "Onaylarım": the steps whose turn it is and that are the user's to decide (PROJECT.md 9, screen 7). */
export function ApprovalsList() {
  const [page, setPage] = useState(1);
  const [target, setTarget] = useState<DecisionTarget | null>(null);

  const pending = useQuery({
    queryKey: ["approvals-pending", page],
    queryFn: () => getPendingApprovals(page),
    placeholderData: keepPreviousData,
    // What somebody else decided meanwhile should not stay on the screen
    refetchOnWindowFocus: true,
  });

  const totalPages = pending.data ? Math.max(1, Math.ceil(pending.data.total / DEFAULT_PAGE_SIZE)) : 1;
  // The last item of the last page was just decided: that page no longer exists
  const pastLastPage = pending.data && !pending.isPlaceholderData && page > totalPages;
  if (pastLastPage) setPage(totalPages);

  return (
    <div className="space-y-4">
      {pending.isPending && <p className="text-muted" role="status">{tr.common.loading}</p>}

      {pending.isError && !pending.data && (
        <div role="alert" className="space-y-2">
          <p className="text-sm text-destructive">{t.loadError}</p>
          <Button variant="outline" size="sm" onClick={() => pending.refetch()}>
            {tr.common.retry}
          </Button>
        </div>
      )}

      {pending.data && pending.data.total === 0 && <p className="py-8 text-center text-muted">{t.empty}</p>}

      {pending.data && pending.data.total > 0 && (
        <div className={pending.isPlaceholderData ? "opacity-60 transition-opacity" : undefined}>
          <p className="mb-2 text-sm text-muted">{t.total(pending.data.total)}</p>

          <div className="hidden overflow-x-auto rounded-lg border border-border bg-card md:block">
            <table className="w-full text-left text-sm" aria-label={t.tableLabel}>
              <thead className="border-b border-border bg-accent/60">
                <tr>
                  {(["document", "revision", "type", "step", "requestedBy", "date", "actions"] as const).map((column) => (
                    <th key={column} scope="col" className="px-4 py-3 font-medium whitespace-nowrap">
                      {t.columns[column]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pending.data.items.map((item) => (
                  <tr key={item.stepId} className="border-b border-border align-top last:border-0">
                    <td className="px-4 py-3"><DocumentCell item={item} /></td>
                    <td className="px-4 py-3 whitespace-nowrap">{tr.approval.revision(item.revision.revisionNo)}</td>
                    <td className="px-4 py-3 whitespace-nowrap">{tr.approval.type[item.request.type]}</td>
                    <td className="px-4 py-3 whitespace-nowrap">{tr.approval.step(item.stepOrder)}</td>
                    <td className="px-4 py-3">{item.request.requestedBy.fullName}</td>
                    <td className="px-4 py-3 whitespace-nowrap">{formatDateTime(item.request.createdAt)}</td>
                    <td className="px-4 py-3"><ItemActions item={item} onDecide={setTarget} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="space-y-3 md:hidden" aria-label={t.tableLabel}>
            {pending.data.items.map((item) => (
              <li key={item.stepId}>
                <Card className="space-y-3 p-4">
                  <DocumentCell item={item} />
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                    <dt className="text-muted">{t.columns.revision}</dt>
                    <dd>{tr.approval.revision(item.revision.revisionNo)} ({tr.approval.type[item.request.type]})</dd>
                    <dt className="text-muted">{t.columns.step}</dt>
                    <dd>{tr.approval.step(item.stepOrder)}</dd>
                    <dt className="text-muted">{t.columns.requestedBy}</dt>
                    <dd>{item.request.requestedBy.fullName}, {formatDateTime(item.request.createdAt)}</dd>
                  </dl>
                  <ItemActions item={item} onDecide={setTarget} />
                </Card>
              </li>
            ))}
          </ul>

          {totalPages > 1 && (
            <div className="mt-4 flex justify-center">
              <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
            </div>
          )}
        </div>
      )}

      <DecisionDialog target={target} onClose={() => setTarget(null)} />
    </div>
  );
}
