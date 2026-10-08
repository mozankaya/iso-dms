"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "@/lib/auth/auth-context";

export const CHANGE_PASSWORD_PATH = "/change-password";

/**
 * Sends visitors without a session to the login page, and users who still have a temporary password to the
 * page where they replace it (the API refuses everything else until they do). Returns the auth state for the
 * caller to render on; the change-password page itself passes `allowPasswordChange`.
 */
export function useRequireAuth({ allowPasswordChange = false }: { allowPasswordChange?: boolean } = {}) {
  const auth = useAuth();
  const router = useRouter();
  const mustChange = auth.status === "authenticated" && auth.user?.mustChangePassword === true;

  useEffect(() => {
    if (auth.status === "unauthenticated") router.replace("/login");
    else if (mustChange && !allowPasswordChange) router.replace(CHANGE_PASSWORD_PATH);
  }, [auth.status, mustChange, allowPasswordChange, router]);

  return auth;
}
