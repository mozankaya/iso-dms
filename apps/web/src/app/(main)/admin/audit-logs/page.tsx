import { Suspense } from "react";
import { AuditLogList } from "@/components/audit/audit-log-list";
import { tr } from "@/lib/i18n/tr";

export default function AuditLogsPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">{tr.audit.title}</h1>
        <p className="mt-1 text-sm text-muted">{tr.audit.description}</p>
      </div>
      <Suspense fallback={<p className="text-muted">{tr.common.loading}</p>}>
        <AuditLogList />
      </Suspense>
    </div>
  );
}
