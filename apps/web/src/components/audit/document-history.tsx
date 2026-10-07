"use client";

import { DEFAULT_PAGE_SIZE } from "@iso-dms/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { AuditLogTable } from "@/components/audit/audit-log-table";
import { Pagination } from "@/components/pagination";
import { Button } from "@/components/ui/button";
import { getDocumentAuditLogs } from "@/lib/api/endpoints";
import { tr } from "@/lib/i18n/tr";

const t = tr.audit;

/** The audit trail of one document and its revisions, loaded only when somebody asks for it. */
export function DocumentHistory({ documentId, showAddress }: { documentId: string; showAddress: boolean }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);

  const logs = useQuery({
    queryKey: ["audit-logs", "document", documentId, page],
    queryFn: () => getDocumentAuditLogs(documentId, { page, pageSize: DEFAULT_PAGE_SIZE }),
    placeholderData: keepPreviousData,
    enabled: open,
  });
  const totalPages = logs.data ? Math.max(1, Math.ceil(logs.data.total / DEFAULT_PAGE_SIZE)) : 1;

  return (
    <section aria-labelledby="document-history-heading" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="document-history-heading" className="text-lg font-semibold">
          {t.documentTitle}
        </h2>
        <Button variant="outline" size="sm" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {open ? t.hide : t.show}
        </Button>
      </div>

      {open && logs.isPending && <p className="text-muted" role="status">{tr.common.loading}</p>}

      {open && logs.isError && !logs.data && (
        <div role="alert" className="space-y-2">
          <p className="text-sm text-destructive">{t.loadError}</p>
          <Button variant="outline" size="sm" onClick={() => logs.refetch()}>
            {tr.common.retry}
          </Button>
        </div>
      )}

      {open && logs.data && logs.data.total === 0 && <p className="text-muted">{t.empty}</p>}

      {open && logs.data && logs.data.total > 0 && (
        <div className={logs.isPlaceholderData ? "opacity-60 transition-opacity" : undefined}>
          <p className="mb-2 text-sm text-muted">{t.total(logs.data.total)}</p>
          <AuditLogTable items={logs.data.items} showDocument={false} showAddress={showAddress} />
          {totalPages > 1 && (
            <div className="mt-4 flex justify-center">
              <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
