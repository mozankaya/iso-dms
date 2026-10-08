"use client";

import { REVIEW_INTERVAL_MAX_MONTHS, REVIEW_INTERVAL_MIN_MONTHS, type DocumentDetailDto } from "@iso-dms/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import { TextAreaField } from "@/components/documents/text-area-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import { ApiError } from "@/lib/api/client";
import { markDocumentReviewed, updateReviewSettings } from "@/lib/api/endpoints";
import { errorMessage, tr } from "@/lib/i18n/tr";

const t = tr.review;

/** Everything that shows a document, its review dates or the counter of reviews has to be fetched again. */
function refreshAfterReview(queryClient: ReturnType<typeof useQueryClient>, documentId: string) {
  return Promise.all(
    [["document", documentId], ["documents"], ["review-due"], ["dashboard-stats"], ["audit-logs"]].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
  );
}

function ReviewedDialog({ document, onClose }: { document: DocumentDetailDto; onClose: () => void }) {
  const queryClient = useQueryClient();
  const noteId = useId();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const mark = useMutation({ mutationFn: () => markDocumentReviewed(document.id, note.trim() || undefined) });

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await mark.mutateAsync();
    } catch (caught) {
      setError(caught instanceof ApiError ? errorMessage(caught) : tr.errors.NETWORK);
      return;
    }
    await refreshAfterReview(queryClient, document.id);
    onClose();
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <p className="text-sm">{t.reviewedConfirm(document.code)}</p>
      <TextAreaField id={noteId} label={t.note} hint={t.noteHint} value={note} onChange={setNote} invalid={false} />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onClose} disabled={mark.isPending}>
          {t.cancel}
        </Button>
        <Button type="submit" disabled={mark.isPending}>
          {mark.isPending ? t.saving : t.reviewedSubmit}
        </Button>
      </div>
    </form>
  );
}

function IntervalDialog({ document, onClose }: { document: DocumentDetailDto; onClose: () => void }) {
  const queryClient = useQueryClient();
  const intervalId = useId();
  const [value, setValue] = useState(document.reviewIntervalMonths ? String(document.reviewIntervalMonths) : "");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const months = value.trim() === "" ? null : Number(value);
  const invalid = months !== null && (!Number.isInteger(months) || months < REVIEW_INTERVAL_MIN_MONTHS || months > REVIEW_INTERVAL_MAX_MONTHS);
  const save = useMutation({ mutationFn: () => updateReviewSettings(document.id, months) });

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    setError(null);
    if (invalid) return;
    try {
      await save.mutateAsync();
    } catch (caught) {
      setError(caught instanceof ApiError ? errorMessage(caught) : tr.errors.NETWORK);
      return;
    }
    await refreshAfterReview(queryClient, document.id);
    onClose();
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <div className="space-y-1.5">
        <Label htmlFor={intervalId}>{t.intervalLabel}</Label>
        <Input id={intervalId} inputMode="numeric" value={value} onChange={(event) => setValue(event.target.value)} aria-invalid={submitted && invalid ? true : undefined} />
        {submitted && invalid ? <p className="text-sm text-destructive">{t.intervalInvalid(REVIEW_INTERVAL_MIN_MONTHS, REVIEW_INTERVAL_MAX_MONTHS)}</p> : <p className="text-xs text-muted">{t.intervalHint}</p>}
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onClose} disabled={save.isPending}>
          {t.cancel}
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? t.saving : t.save}
        </Button>
      </div>
    </form>
  );
}

/** "Gözden Geçirildi" and the review period of a document (PROJECT.md 6.5); each shows only for those who may. */
export function ReviewActions({ document }: { document: DocumentDetailDto }) {
  const [dialog, setDialog] = useState<"reviewed" | "interval" | null>(null);
  if (!document.canMarkReviewed && !document.canSetReviewInterval) return null;
  const close = () => setDialog(null);

  return (
    <>
      {document.canMarkReviewed && (
        <Button variant="outline" onClick={() => setDialog("reviewed")}>
          {t.reviewed}
        </Button>
      )}
      {document.canSetReviewInterval && (
        <Button variant="outline" onClick={() => setDialog("interval")}>
          {t.setInterval}
        </Button>
      )}
      <Modal open={dialog === "reviewed"} onClose={close} title={t.reviewedTitle}>
        {dialog === "reviewed" && <ReviewedDialog document={document} onClose={close} />}
      </Modal>
      <Modal open={dialog === "interval"} onClose={close} title={t.intervalTitle}>
        {dialog === "interval" && <IntervalDialog document={document} onClose={close} />}
      </Modal>
    </>
  );
}
