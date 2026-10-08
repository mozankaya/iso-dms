import { ChangePasswordForm } from "@/components/auth/change-password-form";
import { tr } from "@/lib/i18n/tr";

export default function ChangePasswordPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-4">
      <p className="text-lg font-semibold">{tr.app.title}</p>
      <ChangePasswordForm />
    </main>
  );
}
