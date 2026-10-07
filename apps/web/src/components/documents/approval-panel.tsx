"use client";

import type { ApprovalRequestDto, ApprovalStepDto, DocumentDetailDto } from "@iso-dms/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Circle, XCircle } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { DecisionDialog, type DecisionTarget } from "@/components/documents/decision-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Modal } from "@/components/ui/modal";
import { ApiError } from "@/lib/api/client";
import { cancelApprovalRequest } from "@/lib/api/endpoints";
import { invalidateAfterApprovalChange } from "@/lib/documents/invalidate";
import { formatDateTime } from "@/lib/format";
import { errorMessage, tr } from "@/lib/i18n/tr";
import { cn } from "@/lib/utils";

const t = tr.approval;

const STATUS_STYLES: Record<ApprovalRequestDto["status"], string> = {
  PENDING: "bg-amber-100 text-amber-800",
  APPROVED: "bg-emerald-100 text-emerald-800",
  REJECTED: "bg-orange-100 text-orange-800",
  CANCELLED: "bg-slate-100 text-slate-700",
};

function StepIcon({ decision }: { decision: ApprovalStepDto["decision"] }) {
  if (decision === "APPROVED") return <CheckCircle2 className="h-5 w-5 text-emerald-600" aria-hidden="true" />;
  if (decision === "REJECTED") return <XCircle className="h-5 w-5 text-destructive" aria-hidden="true" />;
  return <Circle className="h-5 w-5 text-muted" aria-hidden="true" />;
}

/** Takes the request back: only possible while nobody has decided, and only for whoever sent it. */
function CancelRequestButton({ documentId, requestId }: { documentId: string; requestId: string }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = useMutation({ mutationFn: () => cancelApprovalRequest(requestId) });

  async function confirm() {
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
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        {t.cancel}
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title={t.cancelTitle}>
        <div className="space-y-4">
          <p className="text-sm">{t.cancelConfirm}</p>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setOpen(false)} disabled={cancel.isPending}>
              {t.close}
            </Button>
            <Button onClick={confirm} disabled={cancel.isPending}>
              {cancel.isPending ? t.cancelling : t.cancelSubmit}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

/**
 * The approval of the revision a document is about: who has to decide, who did, what they said, and what the
 * current user may do about it. A rejected request stays visible until the draft is sent again, so its reason
 * does not get lost.
 */
export function ApprovalPanel({ document }: { document: DocumentDetailDto }) {
  const approval = document.approval;
  const [target, setTarget] = useState<DecisionTarget | null>(null);
  if (!approval) return null;

  return (
    <section aria-labelledby="approval-heading" className="space-y-3">
      <h2 id="approval-heading" className="text-lg font-semibold">
        {t.title}
      </h2>

      <Card className="space-y-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <p className="flex flex-wrap items-center gap-2 font-medium">
              <span>{t.revision(approval.revision.revisionNo)}</span>
              <span className="text-sm font-normal text-muted">({t.type[approval.type]})</span>
              <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", STATUS_STYLES[approval.status])}>
                {t.status[approval.status]}
              </span>
            </p>
            <p className="text-sm text-muted">{t.requestedBy(approval.requestedBy.fullName, formatDateTime(approval.createdAt))}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {approval.status === "PENDING" && (
              <Link href={`/documents/${document.id}/edit?revision=${approval.revision.id}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                {t.review}
              </Link>
            )}
            {approval.canCancel && <CancelRequestButton documentId={document.id} requestId={approval.id} />}
          </div>
        </div>

        <ol className="space-y-3" aria-label={t.title}>
          {approval.steps.map((step) => (
            <li key={step.id} className="flex items-start gap-3">
              <StepIcon decision={step.decision} />
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="text-sm font-medium">
                  {t.step(step.stepOrder)} · {t.roles[step.approverRole]}
                  <span className="ml-2 font-normal text-muted">
                    {t.decision[step.decision]}
                    {step.approver && step.decidedAt && ` · ${t.decidedBy(step.approver.fullName, formatDateTime(step.decidedAt))}`}
                  </span>
                </p>
                {step.comment && <p className="text-sm break-words">{step.comment}</p>}
              </div>
              {step.canDecide && (
                <div className="flex shrink-0 gap-2">
                  {(["approve", "reject"] as const).map((mode) => (
                    <Button
                      key={mode}
                      size="sm"
                      variant={mode === "approve" ? "default" : "outline"}
                      onClick={() =>
                        setTarget({ stepId: step.id, mode, documentId: document.id, code: document.code, revisionNo: approval.revision.revisionNo })
                      }
                    >
                      {mode === "approve" ? t.approve : t.reject}
                    </Button>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ol>

        {approval.status === "REJECTED" && document.canSubmit && (
          <p role="status" className="rounded-md border border-orange-200 bg-orange-50 px-4 py-3 text-sm text-orange-900">
            {t.rejectedNotice}
          </p>
        )}
      </Card>

      <DecisionDialog target={target} onClose={() => setTarget(null)} />
    </section>
  );
}
