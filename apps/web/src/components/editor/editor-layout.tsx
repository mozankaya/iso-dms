"use client";

import type { ReactNode } from "react";
import { useRequireAuth } from "@/lib/auth/use-require-auth";
import { tr } from "@/lib/i18n/tr";

/** Full-screen frame for the editor: no navigation, only a signed-in user. */
export function EditorLayout({ children }: { children: ReactNode }) {
  const { status } = useRequireAuth();

  if (status !== "authenticated") {
    return (
      <div className="flex flex-1 items-center justify-center text-muted" role="status">
        {tr.common.loading}
      </div>
    );
  }
  return <div className="flex h-screen flex-col">{children}</div>;
}
