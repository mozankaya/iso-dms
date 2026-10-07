"use client";

import type { OpenRevisionDto } from "@iso-dms/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import { TextAreaField } from "@/components/documents/text-area-field";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { ApiError } from "@/lib/api/client";
import { cancelRevision } from "@/lib/api/endpoints";
import { invalidateAfterApprovalChange } from "@/lib/documents/invalidate";
import { errorMessage, tr } from "@/lib/i18n/tr";

const t = tr.cancelRevision;

/**
 * "Revizyonu İptal Et": gives up a revision that was started and is no longer wanted. The draft stays on record
 * (rejected), the document in force is untouched. A reason is required; server refusals stay in the dialog.
 */
export function CancelRevisionButton({
  documentId,
  code,
  revision,
}: {
  documentId: string;
  code: string;
  revision: OpenRevisionDto;
}) {
  const queryClient = useQueryClient();
  const reasonId = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const cancel = useMutation({ mutationFn: () => cancelRevision(revision.id, reason.trim()) });

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
      await cancel.mutateAsync();
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
          <p className="text-sm">{t.confirm(code, revision.revisionNo)}</p>

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
            <Button variant="outline" onClick={() => setOpen(false)} disabled={cancel.isPending}>
              {t.cancel}
            </Button>
            <Button type="submit" variant="destructive" disabled={cancel.isPending}>
              {cancel.isPending ? t.submitting : t.submit}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
