"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { type FormEvent, useId, useState } from "react";
import { TextAreaField } from "@/components/documents/text-area-field";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { ApiError } from "@/lib/api/client";
import { startRevision } from "@/lib/api/endpoints";
import { errorMessage, tr } from "@/lib/i18n/tr";

const t = tr.startRevision;

/**
 * "Revizyon Başlat": a new draft begins as a copy of the revision in force and opens in the editor. The
 * author says what is going to change first (PROJECT.md 6.2 rule 6). Server refusals stay in the dialog.
 */
export function StartRevisionButton({ documentId, code }: { documentId: string; code: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const summaryId = useId();
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState("");
  const [error, setError] = useState<string | null>(null);

  const start = useMutation({ mutationFn: () => startRevision(documentId, summary.trim()) });

  function openDialog() {
    setSummary("");
    setError(null);
    setOpen(true);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!summary.trim()) {
      setError(t.changeSummaryRequired);
      return;
    }

    setError(null);
    try {
      await start.mutateAsync();
    } catch (caught) {
      setError(caught instanceof ApiError ? errorMessage(caught) : tr.errors.NETWORK);
      return;
    }
    // The document, its history and the lists all know a draft more now
    await Promise.all(
      [["document", documentId], ["revisions", documentId], ["documents"]].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    );
    router.push(`/documents/${documentId}/edit`);
  }

  return (
    <>
      <Button variant="outline" onClick={openDialog}>
        {t.button}
      </Button>

      <Modal open={open} onClose={() => setOpen(false)} title={t.dialogTitle}>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <p className="text-sm">{t.confirm(code)}</p>

          <TextAreaField
            id={summaryId}
            label={t.changeSummary}
            hint={t.changeSummaryHint}
            value={summary}
            onChange={setSummary}
            invalid={error === t.changeSummaryRequired}
          />

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setOpen(false)} disabled={start.isPending}>
              {t.cancel}
            </Button>
            <Button type="submit" disabled={start.isPending}>
              {start.isPending ? t.submitting : t.submit}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
