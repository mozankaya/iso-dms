import { Suspense } from "react";
import { ReviewDueList } from "@/components/documents/review-due-list";
import { tr } from "@/lib/i18n/tr";

export default function ReviewDuePage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">{tr.reviewDue.title}</h1>
        <p className="mt-1 text-sm text-muted">{tr.reviewDue.description}</p>
      </div>
      <Suspense fallback={<p className="text-muted">{tr.common.loading}</p>}>
        <ReviewDueList />
      </Suspense>
    </div>
  );
}
