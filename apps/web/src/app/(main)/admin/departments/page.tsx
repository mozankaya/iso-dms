import { DepartmentAdmin } from "@/components/admin/department-admin";
import { tr } from "@/lib/i18n/tr";

export default function DepartmentsPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">{tr.admin.departments.title}</h1>
        <p className="mt-1 text-sm text-muted">{tr.admin.departments.description}</p>
      </div>
      <DepartmentAdmin />
    </div>
  );
}
