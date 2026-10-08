import { Suspense } from "react";
import { UserAdmin } from "@/components/admin/user-admin";
import { tr } from "@/lib/i18n/tr";

export default function UsersPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">{tr.admin.users.title}</h1>
        <p className="mt-1 text-sm text-muted">{tr.admin.users.description}</p>
      </div>
      <Suspense fallback={<p className="text-muted">{tr.common.loading}</p>}>
        <UserAdmin />
      </Suspense>
    </div>
  );
}
