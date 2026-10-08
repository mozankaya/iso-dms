import { Suspense } from "react";
import { RevisionCompare } from "@/components/documents/revision-compare";
import { tr } from "@/lib/i18n/tr";

export default async function ComparePage({ params }: PageProps<"/documents/[id]/compare">) {
  const { id } = await params;
  return (
    <Suspense fallback={<p className="text-muted">{tr.common.loading}</p>}>
      <RevisionCompare documentId={id} />
    </Suspense>
  );
}
