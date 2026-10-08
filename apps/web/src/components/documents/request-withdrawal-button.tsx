"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import { TextAreaField } from "@/components/documents/text-area-field";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { ApiError } from "@/lib/api/client";
import { requestWithdrawal } from "@/lib/api/endpoints";
import { invalidateAfterApprovalChange } from "@/lib/documents/invalidate";
import { errorMessage, tr } from "@/lib/i18n/tr";

const t = tr.withdrawal;

/**
 * "Yayından Kaldırma Talebi": asks for a document in force to be taken out of use (PROJECT.md 6.2 rule 7). The reason
 * is required. Nothing changes until the approvers agree; server refusals stay in the dialog.
 */
export function RequestWithdrawalButton({ documentId, code }: { documentId: string; code: string }) {
  const queryClient = useQueryClient();
  const reasonId = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const ask = useMutation({ mutationFn: () => requestWithdrawal(documentId, reason.trim()) });

  function openDialog() {
    setReason("");
    setError(null);
    setOpen(true);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!reason.trim()) {
      setError(t.reasonRequired);
      return;
    }

    setError(null);
    try {
      await ask.mutateAsync();
    } catch (caught) {
      setError(caught instanceof ApiError ? errorMessage(caught) : tr.errors.NETWORK);
      return;
    }
    await invalidateAfterApprovalChange(queryClient, documentId);
    setOpen(false);
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
            id={reasonId}
            label={t.reason}
            hint={t.reasonHint}
            value={reason}
            onChange={setReason}
            invalid={error === t.reasonRequired}
          />

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setOpen(false)} disabled={ask.isPending}>
              {t.cancel}
            </Button>
            <Button type="submit" variant="destructive" disabled={ask.isPending}>
              {ask.isPending ? t.submitting : t.submit}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
