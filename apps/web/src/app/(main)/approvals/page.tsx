import { ApprovalsGate } from "@/components/documents/approvals-gate";
import { tr } from "@/lib/i18n/tr";

export default function ApprovalsPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">{tr.approvals.title}</h1>
        <p className="mt-1 text-sm text-muted">{tr.approvals.description}</p>
      </div>
      <ApprovalsGate />
    </div>
  );
}
