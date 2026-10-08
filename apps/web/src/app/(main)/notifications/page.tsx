import { Suspense } from "react";
import { NotificationList } from "@/components/notifications/notification-list";
import { tr } from "@/lib/i18n/tr";

export default function NotificationsPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">{tr.notifications.title}</h1>
        <p className="mt-1 text-sm text-muted">{tr.notifications.description}</p>
      </div>
      <Suspense fallback={<p className="text-muted">{tr.common.loading}</p>}>
        <NotificationList />
      </Suspense>
    </div>
  );
}
