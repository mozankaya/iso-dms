"use client";

import type { RevisionSummaryDto } from "@iso-dms/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import { ApiError } from "@/lib/api/client";
import { publishRevision } from "@/lib/api/endpoints";
import { errorMessage, tr } from "@/lib/i18n/tr";

const t = tr.publish;

/** Everything that shows a published document or a count of them has to be fetched again. */
const STALE_AFTER_PUBLISH = ["documents", "categories", "dashboard-stats"] as const;

/**
 * "Yayınla" with a confirmation: publishing cannot be undone. From the second revision on the publisher
 * must say what changed. Server refusals (somebody still editing, editor server down) stay in the dialog.
 */
export function PublishButton({
  documentId,
  code,
  revision,
}: {
  documentId: string;
  code: string;
  revision: RevisionSummaryDto;
}) {
  const queryClient = useQueryClient();
  const summaryId = useId();
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState("");
  const [error, setError] = useState<string | null>(null);
  const needsSummary = revision.revisionNo > 0;

  const publish = useMutation({ mutationFn: () => publishRevision(revision.id, summary.trim() || undefined) });

  function openDialog() {
    setSummary("");
    setError(null);
    setOpen(true);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (needsSummary && !summary.trim()) {
      setError(t.changeSummaryRequired);
      return;
    }

    setError(null);
    try {
      await publish.mutateAsync();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["document", documentId] }),
        queryClient.invalidateQueries({ queryKey: ["revisions", documentId] }),
        ...STALE_AFTER_PUBLISH.map((key) => queryClient.invalidateQueries({ queryKey: [key] })),
      ]);
      setOpen(false);
    } catch (caught) {
      setError(caught instanceof ApiError ? errorMessage(caught) : tr.errors.NETWORK);
    }
  }

  return (
    <>
      <Button onClick={openDialog}>{t.button}</Button>

      <Modal open={open} onClose={() => setOpen(false)} title={t.dialogTitle}>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <p className="text-sm">{t.confirm(code, revision.revisionNo)}</p>

          {needsSummary && (
            <div className="space-y-1.5">
              <Label htmlFor={summaryId}>{t.changeSummary}</Label>
              <textarea
                id={summaryId}
                value={summary}
                onChange={(event) => setSummary(event.target.value)}
                rows={3}
                maxLength={2000}
                placeholder={t.changeSummaryHint}
                aria-invalid={error === t.changeSummaryRequired ? true : undefined}
                className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm placeholder:text-muted focus-visible:outline-2 focus-visible:outline-primary aria-invalid:border-destructive"
              />
            </div>
          )}

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setOpen(false)} disabled={publish.isPending}>
              {t.cancel}
            </Button>
            <Button type="submit" disabled={publish.isPending}>
              {publish.isPending ? t.submitting : t.submit}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
