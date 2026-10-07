"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { OnlyOfficeEditor } from "@/components/editor/onlyoffice-editor";
import { StatusBadge } from "@/components/documents/status-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { ApiError } from "@/lib/api/client";
import { getDocument, getEditorSession } from "@/lib/api/endpoints";
import { errorMessage, tr } from "@/lib/i18n/tr";
import { loadOnlyOfficeApi } from "@/lib/onlyoffice/load-api";
import { cn } from "@/lib/utils";

function Notice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="max-w-md text-destructive">{message}</p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          {tr.common.retry}
        </Button>
      )}
    </div>
  );
}

function messageFor(error: unknown): string {
  return error instanceof ApiError ? errorMessage(error) : tr.errors.NETWORK;
}

export function EditorScreen({
  documentId,
  requestedRevisionId,
}: {
  documentId: string;
  /** A specific revision to open (from the revision history); by default the one the API picks */
  requestedRevisionId?: string;
}) {
  const [editorError, setEditorError] = useState<string | null>(null);

  const document = useQuery({
    queryKey: ["document", documentId],
    queryFn: () => getDocument(documentId),
    gcTime: 0,
  });
  const revisionId = requestedRevisionId ?? document.data?.openRevision?.id;

  // The configuration holds short-lived tokens and defines the running editor: it is fetched once per visit
  // and never refreshed in the background (a new object would restart the editor under the user's hands).
  const session = useQuery({
    queryKey: ["editor-session", revisionId],
    queryFn: () => getEditorSession(revisionId!),
    enabled: Boolean(revisionId),
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const editorApi = useQuery({
    queryKey: ["onlyoffice-api"],
    // A query must resolve to a value: undefined is rejected by TanStack Query
    queryFn: async () => {
      await loadOnlyOfficeApi();
      return true;
    },
    staleTime: Infinity,
    retry: false,
  });

  // Back to the page the user came from: the document's detail page
  const backHref = `/documents/${documentId}`;

  let body;
  if (document.isError) {
    body = <Notice message={messageFor(document.error)} onRetry={() => document.refetch()} />;
  } else if (document.data && !revisionId) {
    body = <Notice message={tr.editor.noRevision} />;
  } else if (session.isError) {
    body = <Notice message={messageFor(session.error)} onRetry={() => session.refetch()} />;
  } else if (editorApi.isError) {
    body = <Notice message={tr.editor.serverUnreachable} onRetry={() => editorApi.refetch()} />;
  } else if (editorError !== null) {
    body = (
      <Notice
        message={editorError ? `${tr.editor.editorError} (${editorError})` : tr.editor.editorError}
        onRetry={() => setEditorError(null)}
      />
    );
  } else if (session.data && editorApi.isSuccess) {
    body = (
      <div className="min-h-0 flex-1">
        <OnlyOfficeEditor config={session.data.config} onError={setEditorError} />
      </div>
    );
  } else {
    body = (
      <p className="flex flex-1 items-center justify-center text-muted" role="status">
        {tr.editor.preparing}
      </p>
    );
  }

  const mode = session.data?.mode;
  return (
    <>
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-card px-4 py-2">
        <Link
          href={backHref}
          className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-primary"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          {tr.editor.back}
        </Link>

        {document.data && (
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-mono text-sm text-muted">{document.data.code}</span>
            <h1 className="min-w-0 truncate font-medium">{document.data.title}</h1>
            <StatusBadge status={document.data.status} />
            {(session.data?.revision ?? document.data.openRevision) && (
              <span className="text-sm text-muted">
                {tr.editor.revision((session.data?.revision ?? document.data.openRevision)!.revisionNo)}
              </span>
            )}
          </div>
        )}

        {mode && (
          <div className="ml-auto flex items-center gap-3 text-sm">
            {mode === "edit" && <span className="hidden text-muted sm:inline">{tr.editor.autosaveHint}</span>}
            {mode === "edit" && document.data?.canSubmit && (
              <Link href={`/documents/${documentId}?submit=1`} className={buttonVariants({ size: "sm" })}>
                {tr.submit.button}
              </Link>
            )}
            <span
              className={cn(
                "rounded-full px-2.5 py-0.5 text-xs font-medium",
                mode === "edit" ? "bg-blue-100 text-blue-800" : "bg-slate-100 text-slate-700",
              )}
            >
              {mode === "edit" ? tr.editor.modeEdit : tr.editor.modeView}
            </span>
          </div>
        )}
      </header>
      {body}
    </>
  );
}
