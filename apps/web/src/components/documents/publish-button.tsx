"use client";

import type { OpenRevisionDto } from "@iso-dms/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import { ChangeSummaryField } from "@/components/documents/change-summary-field";
import { Button } from "@/components/ui/button";
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
  revision: OpenRevisionDto;
}) {
  const queryClient = useQueryClient();
  const summaryId = useId();
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState(revision.changeSummary ?? "");
  const [error, setError] = useState<string | null>(null);
  const needsSummary = revision.revisionNo > 0;

  const publish = useMutation({ mutationFn: () => publishRevision(revision.id, summary.trim() || undefined) });

  function openDialog() {
    // What the author said when the revision was started; the publisher may correct it
    setSummary(revision.changeSummary ?? "");
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
            <ChangeSummaryField
              id={summaryId}
              label={t.changeSummary}
              hint={t.changeSummaryHint}
              value={summary}
              onChange={setSummary}
              invalid={error === t.changeSummaryRequired}
            />
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
