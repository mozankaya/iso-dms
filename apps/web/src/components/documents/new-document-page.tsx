"use client";

import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { NewDocumentForm } from "@/components/documents/new-document-form";
import { Button } from "@/components/ui/button";
import { getCategories, getDepartments } from "@/lib/api/endpoints";
import { useAuth } from "@/lib/auth/auth-context";
import { canCreateDocuments, isDepartmentBound } from "@/lib/auth/permissions";
import { tr } from "@/lib/i18n/tr";

export function NewDocumentPage() {
  const { user } = useAuth();
  const searchParams = useSearchParams();
  const categories = useQuery({ queryKey: ["categories"], queryFn: getCategories });
  const departments = useQuery({ queryKey: ["departments"], queryFn: getDepartments });

  let body;
  if (!user || !canCreateDocuments(user.role)) {
    body = <p role="alert" className="text-destructive">{tr.errors.FORBIDDEN}</p>;
  } else if (isDepartmentBound(user.role) && !user.departmentId) {
    body = <p role="alert" className="text-destructive">{tr.newDocument.noDepartment}</p>;
  } else if (categories.isError || departments.isError) {
    body = (
      <div role="alert" className="space-y-2">
        <p className="text-sm text-destructive">{tr.errors.UNKNOWN}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void categories.refetch();
            void departments.refetch();
          }}
        >
          {tr.common.retry}
        </Button>
      </div>
    );
  } else if (!categories.data || !departments.data) {
    body = <p className="text-muted" role="status">{tr.common.loading}</p>;
  } else {
    const slug = searchParams.get("category");
    const initialCategoryId = categories.data.find((category) => category.slug === slug)?.id ?? "";
    body = (
      <NewDocumentForm
        user={user}
        categories={categories.data}
        departments={departments.data}
        initialCategoryId={initialCategoryId}
      />
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{tr.newDocument.title}</h1>
      {body}
    </div>
  );
}
