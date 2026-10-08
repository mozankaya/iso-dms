"use client";

import { REVIEW_DUE_WINDOW_DAYS, type DocumentDetailDto } from "@iso-dms/shared";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState, type ReactNode } from "react";
import { FeedbackForm } from "@/components/feedback/feedback-form";
import { ApprovalPanel } from "@/components/documents/approval-panel";
import { CancelRevisionButton } from "@/components/documents/cancel-revision-button";
import { DocumentHistory } from "@/components/audit/document-history";
import { DownloadButton } from "@/components/documents/download-button";
import { PdfDownload } from "@/components/documents/pdf-download";
import { ReviewActions } from "@/components/documents/review-actions";
import { RevisionHistory } from "@/components/documents/revision-history";
import { RequestWithdrawalButton } from "@/components/documents/request-withdrawal-button";
import { StartRevisionButton } from "@/components/documents/start-revision-button";
import { SubmitButton } from "@/components/documents/submit-button";
import { StatusBadge } from "@/components/documents/status-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ApiError } from "@/lib/api/client";
import { downloadPath, getDocument, getRevisions } from "@/lib/api/endpoints";
import { useAuth } from "@/lib/auth/auth-context";
import { canRequestPdf, canViewAuditLog } from "@/lib/auth/permissions";
import { formatDate } from "@/lib/format";
import { tr } from "@/lib/i18n/tr";

const t = tr.detail;

function InfoItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="mt-0.5 font-medium">{children}</dd>
    </div>
  );
}

/** A document in force whose review date has passed (or is near) carries a notice; it stays in force (PROJECT.md 6.5). */
function ReviewNotice({ document }: { document: DocumentDetailDto }) {
  // The moment the page was drawn: the notice does not flip while somebody reads it
  const [now] = useState(() => Date.now());
  if (document.status !== "PUBLISHED" || !document.nextReviewAt) return null;
  const remainingDays = (new Date(document.nextReviewAt).getTime() - now) / (24 * 60 * 60 * 1000);
  if (remainingDays > REVIEW_DUE_WINDOW_DAYS) return null;
  const overdue = remainingDays < 0;
  return (
    <p
      role="status"
      className={
        overdue
          ? "rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900"
          : "rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
      }
    >
      {overdue ? tr.review.overdueNotice(formatDate(document.nextReviewAt)) : tr.review.dueSoonNotice(formatDate(document.nextReviewAt))}
    </p>
  );
}

function DocumentInfo({ document }: { document: DocumentDetailDto }) {
  return (
    <Card className="p-5">
      <h2 className="mb-4 text-lg font-semibold">{t.info}</h2>
      <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
        <InfoItem label={t.code}>
          <span className="font-mono">{document.code}</span>
        </InfoItem>
        <InfoItem label={t.category}>
          <Link href={`/categories/${document.category.slug}`} className="text-primary hover:underline">
            {document.category.name}
          </Link>
        </InfoItem>
        <InfoItem label={t.department}>{document.department.name}</InfoItem>
        <InfoItem label={t.owner}>{document.owner.fullName}</InfoItem>
        <InfoItem label={t.fileType}>{document.fileType === "DOCX" ? t.word : t.excel}</InfoItem>
        <InfoItem label={t.currentRevision}>
          {document.status === "WITHDRAWN" ? t.noRevisionInForce : (document.revisionNo ?? t.noCurrentRevision)}
        </InfoItem>
        <InfoItem label={t.firstPublishedAt}>{formatDate(document.firstPublishedAt)}</InfoItem>
        <InfoItem label={t.revisedAt}>{formatDate(document.revisedAt)}</InfoItem>
        <InfoItem label={t.createdAt}>{formatDate(document.createdAt)}</InfoItem>
        <InfoItem label={t.reviewInterval}>
          {document.reviewIntervalMonths ? t.reviewIntervalMonths(document.reviewIntervalMonths) : t.notSet}
        </InfoItem>
        <InfoItem label={t.lastReviewedAt}>{formatDate(document.lastReviewedAt)}</InfoItem>
        <InfoItem label={t.nextReviewAt}>{formatDate(document.nextReviewAt)}</InfoItem>
        <InfoItem label={t.retention}>
          {document.retentionYears ? t.retentionYears(document.retentionYears) : t.notSet}
        </InfoItem>
        {document.status === "WITHDRAWN" && (
          <>
            <InfoItem label={t.withdrawnAt}>{formatDate(document.withdrawnAt)}</InfoItem>
            <InfoItem label={t.withdrawalReason}>{document.withdrawalReason ?? t.notSet}</InfoItem>
          </>
        )}
      </dl>
    </Card>
  );
}

export function DocumentDetail({ documentId }: { documentId: string }) {
  const { user } = useAuth();
  // The editor sends authors here to send the draft to review (see EditorScreen)
  const sendRequested = useSearchParams().get("submit") === "1";
  // Opening the page always shows the current state: the editor may have changed the files since
  const document = useQuery({
    queryKey: ["document", documentId],
    queryFn: () => getDocument(documentId),
    staleTime: 0,
  });
  const revisions = useQuery({
    queryKey: ["revisions", documentId],
    queryFn: () => getRevisions(documentId),
    staleTime: 0,
  });

  if (document.isPending) {
    return (
      <p className="text-muted" role="status">
        {tr.common.loading}
      </p>
    );
  }

  if (document.isError) {
    const notFound = document.error instanceof ApiError && document.error.status === 404;
    return (
      <div role="alert" className="space-y-3">
        <p className="text-destructive">{notFound ? t.notFound : t.loadError}</p>
        {notFound ? (
          <Link href="/" className="text-primary underline">
            {tr.category.backToHome}
          </Link>
        ) : (
          <Button variant="outline" size="sm" onClick={() => document.refetch()}>
            {tr.common.retry}
          </Button>
        )}
      </div>
    );
  }

  const doc = document.data;
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href={`/categories/${doc.category.slug}`}
          className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-primary"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          {doc.category.name}
        </Link>

        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <p className="font-mono text-sm text-muted">{doc.code}</p>
            <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold">
              <span className="min-w-0 break-words">{doc.title}</span>
              <StatusBadge status={doc.status} />
            </h1>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {doc.canSubmit && doc.openRevision && (
              <SubmitButton documentId={doc.id} code={doc.code} revision={doc.openRevision} autoOpen={sendRequested} />
            )}
            {doc.canCancelRevision && doc.openRevision && (
              <CancelRevisionButton documentId={doc.id} code={doc.code} revision={doc.openRevision} />
            )}
            {doc.canStartRevision && <StartRevisionButton documentId={doc.id} code={doc.code} />}
            {doc.canRequestWithdrawal && <RequestWithdrawalButton documentId={doc.id} code={doc.code} />}
            <ReviewActions document={doc} />
            {doc.openRevision && (
              <Link href={`/documents/${doc.id}/edit`} className={buttonVariants()}>
                {doc.canEdit ? t.edit : t.view}
              </Link>
            )}
            {doc.currentRevisionId && doc.status !== "WITHDRAWN" && <DownloadButton path={downloadPath.current(doc.id)} fallbackName={doc.code} />}
            {doc.currentRevisionId && doc.status !== "WITHDRAWN" && doc.pdfStatus && (
              <PdfDownload
                status={doc.pdfStatus}
                path={downloadPath.currentPdf(doc.id)}
                fallbackName={doc.code}
                revisionId={doc.currentRevisionId}
                documentId={doc.id}
                canRequest={canRequestPdf(user?.role)}
              />
            )}
          </div>
        </div>
      </div>

      {doc.status === "WITHDRAWN" && (
        <p role="status" className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          {t.withdrawnNotice}
        </p>
      )}

      <ReviewNotice document={doc} />

      <DocumentInfo document={doc} />

      <ApprovalPanel document={doc} />

      <section aria-labelledby="revision-history-heading" className="space-y-3">
        <h2 id="revision-history-heading" className="text-lg font-semibold">
          {tr.revisions.title}
        </h2>
        {revisions.isPending && (
          <p className="text-muted" role="status">
            {tr.common.loading}
          </p>
        )}
        {revisions.isError && (
          <div role="alert" className="space-y-2">
            <p className="text-sm text-destructive">{tr.revisions.loadError}</p>
            <Button variant="outline" size="sm" onClick={() => revisions.refetch()}>
              {tr.common.retry}
            </Button>
          </div>
        )}
        {revisions.isSuccess && <RevisionHistory documentId={doc.id} code={doc.code} documentStatus={doc.status} revisions={revisions.data} canRequestPdf={canRequestPdf(user?.role)} />}
      </section>

      {doc.canSendFeedback && <FeedbackForm documentId={doc.id} />}

      {canViewAuditLog(user?.role) && <DocumentHistory documentId={doc.id} showAddress={user?.role === "ADMIN"} />}
    </div>
  );
}
