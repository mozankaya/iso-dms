"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Suspense } from "react";
import { DocumentList } from "@/components/documents/document-list";
import { getCategories } from "@/lib/api/endpoints";
import { tr } from "@/lib/i18n/tr";

export function CategoryView({ slug }: { slug: string }) {
  const categories = useQuery({ queryKey: ["categories"], queryFn: getCategories });
  const category = categories.data?.find((item) => item.slug === slug);

  if (categories.isPending) return <p className="text-muted">{tr.common.loading}</p>;

  if (!category) {
    return (
      <div className="space-y-2">
        <p>{tr.category.notFound}</p>
        <Link href="/" className="text-primary underline">
          {tr.category.backToHome}
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{category.name}</h1>
      <Suspense fallback={<p className="text-muted">{tr.common.loading}</p>}>
        <DocumentList categoryId={category.id} />
      </Suspense>
    </div>
  );
}
