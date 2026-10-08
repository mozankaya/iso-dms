"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { CategoryIcon } from "@/components/category-icon";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DASHBOARD_PERIOD_DAYS, type DashboardStatsDto } from "@iso-dms/shared";
import { getCategories, getDashboardStats } from "@/lib/api/endpoints";
import { tr } from "@/lib/i18n/tr";

interface Counter {
  key: string;
  label: string;
  value: number;
  hint?: string;
  href?: string;
}

/** The counters the user's role has business with: a null counter is not shown at all. */
function countersOf(stats: DashboardStatsDto): Counter[] {
  const t = tr.dashboard;
  const counters: (Counter | null)[] = [
    { key: "total", label: t.totalDocuments, value: stats.totalDocuments },
    { key: "new", label: t.newlyPublished, value: stats.newlyPublished, hint: t.lastDays(DASHBOARD_PERIOD_DAYS), href: "/lists/new" },
    { key: "revised", label: t.revised, value: stats.revised, hint: t.lastDays(DASHBOARD_PERIOD_DAYS), href: "/lists/revised" },
    stats.withdrawn === null
      ? null
      : { key: "withdrawn", label: t.withdrawn, value: stats.withdrawn, hint: t.lastDays(DASHBOARD_PERIOD_DAYS), href: "/lists/withdrawn" },
    stats.awaitingApproval === null
      ? null
      : { key: "awaiting", label: t.awaitingApproval, value: stats.awaitingApproval, hint: t.waitingForYou, href: "/approvals" },
    stats.openFeedback === null
      ? null
      : { key: "feedback", label: t.openFeedback, value: stats.openFeedback, hint: t.toBeHandled, href: "/feedback" },
  ];
  return counters.filter((counter): counter is Counter => counter !== null);
}

function CounterCard({ counter }: { counter: Counter }) {
  const body = (
    <>
      <p className="text-sm text-muted">{counter.label}</p>
      <p className="mt-1 text-3xl font-semibold">{counter.value}</p>
      {counter.hint && <p className="mt-1 text-xs text-muted">{counter.hint}</p>}
    </>
  );
  if (!counter.href) return <Card className="h-full p-5">{body}</Card>;
  return (
    <Link href={counter.href} className="block h-full rounded-lg border border-border bg-card p-5 shadow-sm transition-colors hover:border-primary hover:bg-accent">
      {body}
    </Link>
  );
}

export default function DashboardPage() {
  const stats = useQuery({ queryKey: ["dashboard-stats"], queryFn: getDashboardStats });
  const categories = useQuery({ queryKey: ["categories"], queryFn: getCategories });

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold">{tr.dashboard.title}</h1>

      <section aria-label={tr.dashboard.countersLabel}>
        {stats.isError && (
          <div role="alert" className="space-y-2">
            <p className="text-sm text-destructive">{tr.dashboard.statsError}</p>
            <Button variant="outline" size="sm" onClick={() => stats.refetch()}>
              {tr.common.retry}
            </Button>
          </div>
        )}
        {stats.isPending && <p className="text-muted">{tr.common.loading}</p>}
        {stats.isSuccess && (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            {countersOf(stats.data).map((counter) => (
              <li key={counter.key}>
                <CounterCard counter={counter} />
              </li>
            ))}
          </ul>
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
