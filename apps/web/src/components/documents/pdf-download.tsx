"use client";

import type { PdfStatus } from "@iso-dms/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { DownloadButton } from "@/components/documents/download-button";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api/client";
import { requestRevisionPdf } from "@/lib/api/endpoints";
import { errorMessage, tr } from "@/lib/i18n/tr";

const t = tr.pdf;

/**
 * The PDF copy of a revision in force (PROJECT.md 6.12): a download once it exists, a note while it is being made.
 * Only those who look after the copies see that one failed (or never was made) and can ask for it again.
 */
export function PdfDownload({
  status,
  path,
  fallbackName,
  revisionId,
  documentId,
  canRequest,
  ariaLabel,
  variant = "outline",
}: {
  status: PdfStatus;
  path: string;
  fallbackName: string;
  revisionId: string;
  documentId: string;
  /** The user is a quality manager or administrator */
  canRequest: boolean;
  ariaLabel?: string;
  variant?: "outline" | "ghost";
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const request = useMutation({
    mutationFn: async () => {
      await requestRevisionPdf(revisionId);
      return true as const;
    },
  });

  async function ask() {
    setError(null);
    try {
      await request.mutateAsync();
    } catch (caught) {
      setError(caught instanceof ApiError ? errorMessage(caught) : tr.errors.NETWORK);
    }
    // The status of the revision may have changed either way (somebody else may have asked first)
    await Promise.all([["document", documentId], ["revisions", documentId], ["documents"], ["audit-logs"]].map((queryKey) => queryClient.invalidateQueries({ queryKey })));
  }

  if (status === "READY") {
    return <DownloadButton variant={variant} path={path} fallbackName={fallbackName} ariaLabel={ariaLabel ?? t.download} label={t.download} busyLabel={t.downloading} />;
  }
  if (status === "PENDING") {
    return (
      <span role="status" className="text-xs text-muted">
        {t.pending}
      </span>
    );
  }
  // FAILED, or a revision from before copies existed: readers just have no PDF, the quality management can ask
  if (!canRequest) return null;

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <span className="inline-flex items-center gap-2">
        <span className="text-xs text-muted">{status === "FAILED" ? t.failed : t.missing}</span>
        <Button variant="outline" size="sm" onClick={ask} disabled={request.isPending}>
          {request.isPending ? t.requesting : t.request}
        </Button>
      </span>
      {error && (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      )}
    </span>
  );
}
