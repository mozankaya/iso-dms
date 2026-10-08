import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tr } from "@/lib/i18n/tr";
import { AppShell } from "./app-shell";

let role = "READER";
let pathname = "/";
const getPendingApprovals = vi.fn();

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
  getPendingApprovals: (page: number) => getPendingApprovals(page),
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
  getPendingApprovals.mockReset();
  getPendingApprovals.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
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

describe("AppShell approvals", () => {
  it.each(["READER", "EDITOR"])("has no approvals link for %s, and does not ask for waiting steps", (who) => {
    role = who;
    renderShell();

    expect(screen.queryByRole("link", { name: new RegExp(tr.nav.approvals) })).not.toBeInTheDocument();
    expect(getPendingApprovals).not.toHaveBeenCalled();
  });

  it.each(["APPROVER", "QUALITY_MANAGER", "ADMIN"])("links the approvals for %s", async (who) => {
    role = who;
    renderShell();

    expect(screen.getByRole("link", { name: new RegExp(tr.nav.approvals) })).toHaveAttribute("href", "/approvals");
    await waitFor(() => expect(getPendingApprovals).toHaveBeenCalledWith(1));
  });

  it("shows how many steps wait for the user", async () => {
    role = "APPROVER";
    getPendingApprovals.mockResolvedValue({ items: [], total: 3, page: 1, pageSize: 20 });
    renderShell();

    expect(await screen.findByLabelText(tr.approvals.total(3))).toHaveTextContent("3");
  });

  it("shows no badge when nothing waits", async () => {
    role = "APPROVER";
    renderShell();
    await waitFor(() => expect(getPendingApprovals).toHaveBeenCalled());

    expect(screen.queryByLabelText(/bekleyen onay/)).not.toBeInTheDocument();
  });

  it("marks the approvals as the current page when they are open", () => {
    role = "QUALITY_MANAGER";
    pathname = "/approvals";
    renderShell();

    expect(screen.getByRole("link", { name: new RegExp(tr.nav.approvals) })).toHaveAttribute("aria-current", "page");
  });
});

describe("AppShell lists", () => {
  it.each(["READER", "EDITOR", "APPROVER", "QUALITY_MANAGER", "ADMIN"])("links the new and revised lists for %s", (who) => {
    role = who;
    renderShell();

    expect(screen.getByText(tr.lists.navTitle)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: tr.lists.kinds.new.title })).toHaveAttribute("href", "/lists/new");
    expect(screen.getByRole("link", { name: tr.lists.kinds.revised.title })).toHaveAttribute("href", "/lists/revised");
  });

  it.each(["EDITOR", "APPROVER", "QUALITY_MANAGER", "ADMIN"])("links the withdrawn list for %s", (who) => {
    role = who;
    renderShell();
    expect(screen.getByRole("link", { name: tr.lists.kinds.withdrawn.title })).toHaveAttribute("href", "/lists/withdrawn");
  });

  it("does not link the withdrawn list for readers, who never see withdrawn documents", () => {
    role = "READER";
    renderShell();
    expect(screen.queryByRole("link", { name: tr.lists.kinds.withdrawn.title })).not.toBeInTheDocument();
  });

  it("marks the list that is open as the current page", () => {
    role = "ADMIN";
    pathname = "/lists/revised";
    renderShell();

    expect(screen.getByRole("link", { name: tr.lists.kinds.revised.title })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: tr.lists.kinds.new.title })).not.toHaveAttribute("aria-current");
  });
});
