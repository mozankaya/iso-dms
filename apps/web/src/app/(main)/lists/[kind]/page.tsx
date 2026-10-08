import { notFound } from "next/navigation";
import { Suspense } from "react";
import { PublicationList } from "@/components/documents/publication-list";
import { isPublicationListKind } from "@/lib/lists/list-params";
import { tr } from "@/lib/i18n/tr";

export default async function PublicationListPage({ params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;
  if (!isPublicationListKind(kind)) notFound();

  const labels = tr.lists.kinds[kind];
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">{labels.title}</h1>
        <p className="mt-1 text-sm text-muted">{labels.description}</p>
      </div>
      <Suspense fallback={<p className="text-muted">{tr.common.loading}</p>}>
        <PublicationList kind={kind} />
      </Suspense>
    </div>
  );
}
