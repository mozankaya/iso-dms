import { Suspense } from "react";
import { FeedbackList } from "@/components/feedback/feedback-list";
import { tr } from "@/lib/i18n/tr";

export default function FeedbackPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">{tr.feedback.page.title}</h1>
        <p className="mt-1 text-sm text-muted">{tr.feedback.page.description}</p>
      </div>
      <Suspense fallback={<p className="text-muted">{tr.common.loading}</p>}>
        <FeedbackList />
      </Suspense>
    </div>
  );
}
