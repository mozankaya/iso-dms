import { CategoryAdmin } from "@/components/admin/category-admin";
import { tr } from "@/lib/i18n/tr";

export default function CategoriesAdminPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">{tr.admin.categories.title}</h1>
        <p className="mt-1 text-sm text-muted">{tr.admin.categories.description}</p>
      </div>
      <CategoryAdmin />
    </div>
  );
}
