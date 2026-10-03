"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { CategoryIcon } from "@/components/category-icon";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { getCategories, getDashboardStats } from "@/lib/api/endpoints";
import { tr } from "@/lib/i18n/tr";

export default function DashboardPage() {
  const stats = useQuery({ queryKey: ["dashboard-stats"], queryFn: getDashboardStats });
  const categories = useQuery({ queryKey: ["categories"], queryFn: getCategories });

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold">{tr.dashboard.title}</h1>

      <section aria-label={tr.dashboard.totalDocuments}>
        {stats.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {tr.dashboard.statsError}
          </p>
        ) : (
          <Card className="max-w-xs p-5">
            <p className="text-sm text-muted">{tr.dashboard.totalDocuments}</p>
            <p className="mt-1 text-3xl font-semibold">
              {stats.isPending ? "…" : stats.data.totalDocuments}
            </p>
          </Card>
        )}
      </section>

      <section aria-labelledby="categories-heading" className="space-y-4">
        <h2 id="categories-heading" className="text-lg font-semibold">
          {tr.dashboard.categories}
        </h2>

        {categories.isPending && <p className="text-muted">{tr.common.loading}</p>}

        {categories.isError && (
          <div role="alert" className="space-y-2">
            <p className="text-sm text-destructive">{tr.dashboard.categoriesError}</p>
            <Button variant="outline" size="sm" onClick={() => categories.refetch()}>
              {tr.common.retry}
            </Button>
          </div>
        )}

        {categories.isSuccess && categories.data.length === 0 && (
          <p className="text-muted">{tr.dashboard.noCategories}</p>
        )}

        {categories.isSuccess && categories.data.length > 0 && (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {categories.data.map((category) => (
              <li key={category.id}>
                <Link
                  href={`/categories/${category.slug}`}
                  className="flex h-full items-center gap-4 rounded-lg border border-border bg-card p-4 shadow-sm transition-colors hover:border-primary hover:bg-accent"
                >
                  <CategoryIcon name={category.icon} className="h-8 w-8 shrink-0 text-primary" />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{category.name}</span>
                    <span className="block text-sm text-muted">
                      {tr.dashboard.documentCount(category.documentCount)}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
