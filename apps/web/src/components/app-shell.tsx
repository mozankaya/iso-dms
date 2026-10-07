"use client";

import { useQuery } from "@tanstack/react-query";
import { Home, LogOut, Menu, ScrollText, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { CategoryIcon } from "@/components/category-icon";
import { Button } from "@/components/ui/button";
import { getCategories } from "@/lib/api/endpoints";
import { canViewAuditLog } from "@/lib/auth/permissions";
import { useRequireAuth } from "@/lib/auth/use-require-auth";
import { tr } from "@/lib/i18n/tr";
import { cn } from "@/lib/utils";

function NavLink({
  href,
  active,
  onNavigate,
  children,
}: {
  href: string;
  active: boolean;
  onNavigate: () => void;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent",
        active && "bg-accent font-medium text-primary",
      )}
    >
      {children}
    </Link>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { status, user, logout } = useRequireAuth();
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  const categories = useQuery({
    queryKey: ["categories"],
    queryFn: getCategories,
    enabled: status === "authenticated",
  });

  const closeMenu = () => setMenuOpen(false);

  if (status !== "authenticated") {
    return (
      <div className="flex flex-1 items-center justify-center text-muted" role="status">
        {tr.common.loading}
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-1">
      {menuOpen && (
        <div className="fixed inset-0 z-30 bg-black/30 md:hidden" onClick={() => setMenuOpen(false)} aria-hidden="true" />
      )}

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-72 flex-col border-r border-border bg-card transition-transform md:static md:translate-x-0",
          menuOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex h-14 items-center justify-between border-b border-border px-4">
          <span className="font-semibold">{tr.app.shortTitle}</span>
          <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setMenuOpen(false)} aria-label={tr.common.closeMenu}>
            <X className="h-5 w-5" aria-hidden="true" />
          </Button>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto p-3" aria-label={tr.nav.categories}>
          <NavLink href="/" active={pathname === "/"} onNavigate={closeMenu}>
            <Home className="h-4 w-4" aria-hidden="true" />
            {tr.nav.home}
          </NavLink>

          <p className="px-3 pt-4 pb-1 text-xs font-semibold uppercase tracking-wide text-muted">
            {tr.nav.categories}
          </p>
          {categories.data?.map((category) => {
            const href = `/categories/${category.slug}`;
            return (
              <NavLink key={category.id} href={href} active={pathname === href} onNavigate={closeMenu}>
                <CategoryIcon name={category.icon} className="h-4 w-4 shrink-0" />
                <span className="truncate">{category.name}</span>
              </NavLink>
            );
          })}

          {canViewAuditLog(user?.role) && (
            <>
              <p className="px-3 pt-4 pb-1 text-xs font-semibold uppercase tracking-wide text-muted">
                {tr.nav.administration}
              </p>
              <NavLink href="/admin/audit-logs" active={pathname === "/admin/audit-logs"} onNavigate={closeMenu}>
                <ScrollText className="h-4 w-4 shrink-0" aria-hidden="true" />
                {tr.nav.auditLog}
              </NavLink>
            </>
          )}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between border-b border-border bg-card px-4">
          <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setMenuOpen(true)} aria-label={tr.common.menu}>
            <Menu className="h-5 w-5" aria-hidden="true" />
          </Button>
          <div className="ml-auto flex items-center gap-3">
            <span className="text-sm text-muted">{user?.fullName}</span>
            <Button variant="outline" size="sm" onClick={() => logout()}>
              <LogOut className="mr-2 h-4 w-4" aria-hidden="true" />
              {tr.auth.logout}
            </Button>
          </div>
        </header>
        <main className="flex-1 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
