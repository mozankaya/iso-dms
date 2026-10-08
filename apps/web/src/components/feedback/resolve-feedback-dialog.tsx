"use client";

import type { FeedbackDto } from "@iso-dms/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import { TextAreaField } from "@/components/documents/text-area-field";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { ApiError } from "@/lib/api/client";
import { resolveFeedback } from "@/lib/api/endpoints";
import { errorMessage, tr } from "@/lib/i18n/tr";

const t = tr.feedback.resolveDialog;

function ResolveForm({ feedback, onClose }: { feedback: FeedbackDto; onClose: () => void }) {
  const queryClient = useQueryClient();
  const noteId = useId();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const resolve = useMutation({ mutationFn: () => resolveFeedback(feedback.id, note.trim() || undefined) });

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await resolve.mutateAsync();
    } catch (caught) {
      setError(caught instanceof ApiError ? errorMessage(caught) : tr.errors.NETWORK);
      return;
    }
    await Promise.all(
      ["feedback", "dashboard-stats", "audit-logs"].map((key) => queryClient.invalidateQueries({ queryKey: [key] })),
    );
    onClose();
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <p className="text-sm">{t.confirm(feedback.document.code)}</p>
      <blockquote className="max-h-32 overflow-y-auto border-l-2 border-border pl-3 text-sm break-words text-muted">{feedback.message}</blockquote>

      <TextAreaField id={noteId} label={t.note} hint={t.noteHint} value={note} onChange={setNote} invalid={false} />

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onClose} disabled={resolve.isPending}>
          {t.cancel}
        </Button>
        <Button type="submit" disabled={resolve.isPending}>
          {resolve.isPending ? t.submitting : t.submit}
        </Button>
      </div>
    </form>
  );
}

/** Closing a feedback, with an optional note on how it was handled. The form lives only while the dialog is open. */
export function ResolveFeedbackDialog({ feedback, onClose }: { feedback: FeedbackDto | null; onClose: () => void }) {
  return (
    <Modal open={feedback !== null} onClose={onClose} title={t.title}>
      {feedback && <ResolveForm key={feedback.id} feedback={feedback} onClose={onClose} />}
    </Modal>
  );
}
