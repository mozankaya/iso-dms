"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@iso-dms/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError } from "@/lib/api/client";
import { useAuth } from "@/lib/auth/auth-context";
import { useRequireAuth } from "@/lib/auth/use-require-auth";
import { errorMessage, tr } from "@/lib/i18n/tr";

const t = tr.auth.changePassword;

const schema = z
  .object({
    currentPassword: z.string().min(1, tr.validation.passwordRequired),
    newPassword: z.string().min(PASSWORD_MIN_LENGTH, tr.validation.passwordTooShort).max(PASSWORD_MAX_LENGTH),
    confirm: z.string(),
  })
  .refine((values) => values.newPassword === values.confirm, { path: ["confirm"], message: tr.validation.passwordMismatch })
  .refine((values) => values.newPassword !== values.currentPassword, { path: ["newPassword"], message: tr.validation.passwordSame });

type Values = z.infer<typeof schema>;

function Field({ id, label, error, hint, ...props }: { id: string; label: string; error?: string; hint?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type="password" aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-error` : undefined} {...props} />
      {error ? (
        <p id={`${id}-error`} className="text-sm text-destructive">
          {error}
        </p>
      ) : (
        hint && <p className="text-xs text-muted">{hint}</p>
      )}
    </div>
  );
}

/**
 * Choosing a password of one's own. A user who got a temporary password lands here first and cannot go
 * anywhere else until done (the API refuses everything else); anybody else can come here from the header.
 */
export function ChangePasswordForm() {
  const { status, user } = useRequireAuth({ allowPasswordChange: true });
  const { changePassword } = useAuth();
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema) });

  if (status !== "authenticated") {
    return (
      <p className="text-muted" role="status">
        {tr.common.loading}
      </p>
    );
  }

  const forced = user?.mustChangePassword === true;

  async function onSubmit(values: Values) {
    setServerError(null);
    try {
      await changePassword(values.currentPassword, values.newPassword);
      router.replace("/");
    } catch (error) {
      setServerError(error instanceof ApiError ? errorMessage(error) : tr.errors.NETWORK);
    }
  }

  return (
    <Card className="w-full max-w-sm p-6">
      <h1 className="text-xl font-semibold">{t.title}</h1>
      <p className="mt-1 text-sm text-muted">{forced ? t.forcedSubtitle : t.subtitle}</p>

      <form onSubmit={handleSubmit(onSubmit)} className="mt-6 space-y-4" noValidate>
        <Field id="current-password" label={t.current} autoComplete="current-password" error={errors.currentPassword?.message} {...register("currentPassword")} />
        <Field id="new-password" label={t.next} autoComplete="new-password" hint={t.hint} error={errors.newPassword?.message} {...register("newPassword")} />
        <Field id="confirm-password" label={t.confirm} autoComplete="new-password" error={errors.confirm?.message} {...register("confirm")} />
        <p className="text-xs text-muted">{t.otherSessions}</p>

        {serverError && (
          <p role="alert" className="text-sm text-destructive">
            {serverError}
          </p>
        )}

        <div className="flex gap-2">
          {!forced && (
            <Link href="/" className="inline-flex h-10 flex-1 items-center justify-center rounded-md border border-border bg-card text-sm font-medium hover:bg-accent">
              {t.cancel}
            </Link>
          )}
          <Button type="submit" className="flex-1" disabled={isSubmitting}>
            {isSubmitting ? t.submitting : t.submit}
          </Button>
        </div>
      </form>
    </Card>
  );
}
