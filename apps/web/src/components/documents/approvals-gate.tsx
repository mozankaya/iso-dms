"use client";

import { ApprovalsList } from "@/components/documents/approvals-list";
import { useAuth } from "@/lib/auth/auth-context";
import { canDecideApprovals } from "@/lib/auth/permissions";
import { tr } from "@/lib/i18n/tr";

/** Readers and editors have no steps to decide: they get a message instead of a request the API would refuse. */
export function ApprovalsGate() {
  const { user } = useAuth();
  if (!canDecideApprovals(user?.role)) {
    return (
      <p role="alert" className="text-destructive">
        {tr.approvals.forbidden}
      </p>
    );
  }
  return <ApprovalsList />;
}
