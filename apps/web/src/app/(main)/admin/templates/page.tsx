import { TemplateAdmin } from "@/components/admin/template-admin";
import { tr } from "@/lib/i18n/tr";

export default function TemplatesPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">{tr.admin.templates.title}</h1>
        <p className="mt-1 text-sm text-muted">{tr.admin.templates.description}</p>
      </div>
      <TemplateAdmin />
    </div>
  );
}
