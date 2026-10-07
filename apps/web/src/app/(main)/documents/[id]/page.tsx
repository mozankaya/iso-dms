import { Suspense } from "react";
import { tr } from "@/lib/i18n/tr";
import { DocumentDetail } from "@/components/documents/document-detail";

export default async function DocumentPage({ params }: PageProps<"/documents/[id]">) {
  const { id } = await params;
  return (
    <Suspense fallback={<p className="text-muted">{tr.common.loading}</p>}>
      <DocumentDetail documentId={id} />
    </Suspense>
  );
}
