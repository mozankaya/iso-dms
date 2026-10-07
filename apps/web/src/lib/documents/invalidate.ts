import type { QueryClient } from "@tanstack/react-query";

/**
 * Everything that shows a document, its revisions, its approval, a count of documents or of waiting approvals has
 * to be fetched again after the approval flow moved the document on.
 */
export function invalidateAfterApprovalChange(queryClient: QueryClient, documentId: string): Promise<unknown> {
  return Promise.all(
    [["document", documentId], ["revisions", documentId], ["documents"], ["categories"], ["dashboard-stats"], ["approvals-pending"], ["audit-logs"]].map(
      (queryKey) => queryClient.invalidateQueries({ queryKey }),
    ),
  );
}
