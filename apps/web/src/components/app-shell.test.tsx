import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tr } from "@/lib/i18n/tr";
import { AppShell } from "./app-shell";

let role = "READER";
let pathname = "/";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => pathname,
}));
vi.mock("@/lib/auth/use-require-auth", () => ({
  useRequireAuth: () => ({
    status: "authenticated",
    user: { id: "u1", fullName: "Test Kullanıcı", role },
    login: vi.fn(),
    logout: vi.fn(),
  }),
}));
vi.mock("@/lib/api/endpoints", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/endpoints")>()),
  getCategories: () => Promise.resolve([]),
}));

function renderShell() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AppShell>
        <p>içerik</p>
      </AppShell>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  role = "READER";
  pathname = "/";
});

describe("AppShell navigation", () => {
  it.each(["READER", "EDITOR", "APPROVER"])("has no administration section for %s", (who) => {
    role = who;
    renderShell();

    expect(screen.queryByText(tr.nav.administration)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: tr.nav.auditLog })).not.toBeInTheDocument();
  });

  it.each(["QUALITY_MANAGER", "ADMIN"])("links the audit trail for %s", (who) => {
    role = who;
    renderShell();

    expect(screen.getByText(tr.nav.administration)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: tr.nav.auditLog })).toHaveAttribute("href", "/admin/audit-logs");
  });

  it("marks the audit trail as the current page when it is open", () => {
    role = "ADMIN";
    pathname = "/admin/audit-logs";
    renderShell();

    expect(screen.getByRole("link", { name: tr.nav.auditLog })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: tr.nav.home })).not.toHaveAttribute("aria-current");
  });
});
