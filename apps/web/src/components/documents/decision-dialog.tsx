"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import { TextAreaField } from "@/components/documents/text-area-field";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { ApiError } from "@/lib/api/client";
import { decideApproval } from "@/lib/api/endpoints";
import { invalidateAfterApprovalChange } from "@/lib/documents/invalidate";
import { errorMessage, tr } from "@/lib/i18n/tr";

const t = tr.decide;

export interface DecisionTarget {
  stepId: string;
  mode: "approve" | "reject";
  documentId: string;
  code: string;
  revisionNo: number;
}

function DecisionForm({ target, onClose }: { target: DecisionTarget; onClose: () => void }) {
  const queryClient = useQueryClient();
  const commentId = useId();
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const rejecting = target.mode === "reject";

  const decide = useMutation({
    mutationFn: () => decideApproval(target.stepId, target.mode, comment.trim() || undefined),
  });

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (rejecting && !comment.trim()) {
      setError(t.reasonRequired);
      return;
    }

    setError(null);
    try {
      await decide.mutateAsync();
    } catch (caught) {
      setError(caught instanceof ApiError ? errorMessage(caught) : tr.errors.NETWORK);
      return;
    }
    await invalidateAfterApprovalChange(queryClient, target.documentId);
    onClose();
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <p className="text-sm">{(rejecting ? t.rejectConfirm : t.approveConfirm)(target.code, target.revisionNo)}</p>

      <TextAreaField
        id={commentId}
        label={rejecting ? t.reason : t.comment}
        hint={rejecting ? t.reasonHint : t.commentHint}
        value={comment}
        onChange={setComment}
        invalid={error === t.reasonRequired}
      />

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onClose} disabled={decide.isPending}>
          {t.cancel}
        </Button>
        <Button type="submit" variant={rejecting ? "destructive" : "default"} disabled={decide.isPending}>
          {decide.isPending ? t.submitting : rejecting ? t.submitReject : t.submitApprove}
        </Button>
      </div>
    </form>
  );
}

/**
 * Approve or reject one step. An approval may carry a comment; a rejection must say why (PROJECT.md 6.2 rule 5).
 * Server refusals (somebody decided first, it is not your step) stay in the dialog. The form is mounted only while
 * the dialog is open (and per step and decision), so every opening starts clean.
 */
export function DecisionDialog({ target, onClose }: { target: DecisionTarget | null; onClose: () => void }) {
  return (
    <Modal open={target !== null} onClose={onClose} title={target?.mode === "reject" ? t.rejectTitle : t.approveTitle}>
      {target && <DecisionForm key={`${target.stepId}:${target.mode}`} target={target} onClose={onClose} />}
    </Modal>
  );
}
