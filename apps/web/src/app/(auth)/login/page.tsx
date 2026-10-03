import { tr } from "@/lib/i18n/tr";
import { LoginForm } from "./login-form";

export default function LoginPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-4">
      <p className="text-lg font-semibold">{tr.app.title}</p>
      <LoginForm />
    </main>
  );
}
