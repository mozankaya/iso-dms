import { Suspense } from "react";
import { NewDocumentPage } from "@/components/documents/new-document-page";
import { tr } from "@/lib/i18n/tr";

export default function NewDocumentRoute() {
  return (
    <Suspense fallback={<p className="text-muted">{tr.common.loading}</p>}>
      <NewDocumentPage />
    </Suspense>
  );
}
