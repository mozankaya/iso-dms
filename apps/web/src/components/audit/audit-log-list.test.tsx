import type { AuditLogDto, AuditLogPage } from "@iso-dms/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tr } from "@/lib/i18n/tr";
import { auditLogEntry } from "@/test/fixtures";
import { AuditLogList } from "./audit-log-list";

const t = tr.audit;
const PATHNAME = "/admin/audit-logs";

const replace = vi.fn();
let currentSearch = "";
let role = "QUALITY_MANAGER";
const getAuditLogs = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => PATHNAME,
  useSearchParams: () => new URLSearchParams(currentSearch),
}));
vi.mock("@/lib/auth/auth-context", () => ({
  useAuth: () => ({ status: "authenticated", user: { id: "u1", role }, login: vi.fn(), logout: vi.fn() }),
}));
vi.mock("@/lib/api/endpoints", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/endpoints")>()),
  getAuditLogs: (query: unknown) => getAuditLogs(query),
}));

function page(items: AuditLogDto[], total = items.length): AuditLogPage {
  return { items, total, page: 1, pageSize: 20 };
}

function renderList() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuditLogList />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  replace.mockReset();
  getAuditLogs.mockReset();
  currentSearch = "";
  role = "QUALITY_MANAGER";
  getAuditLogs.mockResolvedValue(page([auditLogEntry()]));
});

describe("AuditLogList", () => {
  it("loads the first page and shows the entries with their number", async () => {
    renderList();

    expect(screen.getByRole("status")).toHaveTextContent(tr.common.loading);
    expect(await screen.findByRole("table", { name: t.tableLabel })).toBeInTheDocument();
    expect(screen.getByText(t.total(1))).toBeInTheDocument();
    expect(getAuditLogs).toHaveBeenCalledWith({ search: undefined, action: undefined, from: undefined, to: undefined, page: 1, pageSize: 20 });
  });

  it("does not even ask the API when the user may not read the audit trail", () => {
    role = "EDITOR";
    renderList();

    expect(screen.getByRole("alert")).toHaveTextContent(t.forbidden);
    expect(getAuditLogs).not.toHaveBeenCalled();
  });

  it("shows the address column to administrators only", async () => {
    role = "ADMIN";
    getAuditLogs.mockResolvedValue(page([auditLogEntry({ ipAddress: "203.0.113.7" })]));
    const { unmount } = renderList();
    expect((await screen.findAllByText("203.0.113.7")).length).toBeGreaterThan(0);
    unmount();

    role = "QUALITY_MANAGER";
    renderList();
    await screen.findByRole("table", { name: t.tableLabel });
    expect(screen.queryByRole("columnheader", { name: t.columns.ipAddress })).not.toBeInTheDocument();
  });

  it("reads the filters from the URL", async () => {
    currentSearch = "q=PR-KK&action=REVISION_SAVED&from=2026-01-05&to=2026-02-01&page=2";
    getAuditLogs.mockResolvedValue({ items: [auditLogEntry()], total: 45, page: 2, pageSize: 20 });
    renderList();

    await screen.findByRole("table", { name: t.tableLabel });
    expect(getAuditLogs).toHaveBeenCalledWith({ search: "PR-KK", action: "REVISION_SAVED", from: "2026-01-05", to: "2026-02-01", page: 2, pageSize: 20 });
    expect(screen.getByLabelText(t.searchLabel)).toHaveValue("PR-KK");
    expect(screen.getByLabelText(t.actionFilter)).toHaveValue("REVISION_SAVED");
    expect(screen.getByLabelText(t.fromDate)).toHaveValue("2026-01-05");
    expect(screen.getByLabelText(t.toDate)).toHaveValue("2026-02-01");
  });

  it("offers every action, translated", async () => {
    renderList();
    await screen.findByRole("table", { name: t.tableLabel });

    const options = within(screen.getByLabelText(t.actionFilter)).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([t.allActions, ...Object.values(t.actions)]);
  });

  it("puts a chosen action into the URL and goes back to the first page", async () => {
    currentSearch = "page=3";
    getAuditLogs.mockResolvedValue({ items: [auditLogEntry()], total: 60, page: 3, pageSize: 20 });
    renderList();
    await screen.findByRole("table", { name: t.tableLabel });

    await userEvent.selectOptions(screen.getByLabelText(t.actionFilter), "DOCUMENT_PUBLISHED");

    expect(replace).toHaveBeenLastCalledWith(`${PATHNAME}?action=DOCUMENT_PUBLISHED`, { scroll: false });
  });

  it("puts the dates into the URL", async () => {
    renderList();
    await screen.findByRole("table", { name: t.tableLabel });

    fireEvent.change(screen.getByLabelText(t.fromDate), { target: { value: "2026-03-01" } });

    expect(replace).toHaveBeenLastCalledWith(`${PATHNAME}?from=2026-03-01`, { scroll: false });
  });

  it("waits for a pause in typing before it searches", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderList();
      await screen.findByRole("table", { name: t.tableLabel });

      fireEvent.change(screen.getByLabelText(t.searchLabel), { target: { value: "  PR-KK-001 " } });
      expect(replace).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(350);
      expect(replace).toHaveBeenLastCalledWith(`${PATHNAME}?q=PR-KK-001`, { scroll: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears all filters at once", async () => {
    currentSearch = "q=abc&action=USER_LOGIN&from=2026-01-01";
    renderList();
    await screen.findByRole("table", { name: t.tableLabel });

    await userEvent.click(screen.getByRole("button", { name: t.clearFilters }));

    expect(replace).toHaveBeenLastCalledWith(PATHNAME, { scroll: false });
    expect(screen.getByLabelText(t.searchLabel)).toHaveValue("");
  });

  it("offers no clear button when nothing is filtered", async () => {
    currentSearch = "page=2";
    getAuditLogs.mockResolvedValue({ items: [auditLogEntry()], total: 40, page: 2, pageSize: 20 });
    renderList();
    await screen.findByRole("table", { name: t.tableLabel });

    expect(screen.queryByRole("button", { name: t.clearFilters })).not.toBeInTheDocument();
  });

  it("pages through the results", async () => {
    getAuditLogs.mockResolvedValue({ items: [auditLogEntry()], total: 45, page: 1, pageSize: 20 });
    renderList();
    await screen.findByRole("table", { name: t.tableLabel });

    expect(screen.getByText(tr.documents.pageOf(1, 3))).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: tr.documents.nextPage }));

    expect(replace).toHaveBeenLastCalledWith(`${PATHNAME}?page=2`, { scroll: false });
  });

  it("hides the pager when everything fits on one page", async () => {
    renderList();
    await screen.findByRole("table", { name: t.tableLabel });
    expect(screen.queryByRole("navigation", { name: tr.documents.pagination })).not.toBeInTheDocument();
  });

  it("moves to the last page when the link points past it", async () => {
    currentSearch = "page=9";
    getAuditLogs.mockResolvedValue({ items: [auditLogEntry()], total: 45, page: 9, pageSize: 20 });
    renderList();

    await waitFor(() => expect(replace).toHaveBeenCalledWith(`${PATHNAME}?page=3`, { scroll: false }));
  });

  it("says so when there are no entries, with or without filters", async () => {
    getAuditLogs.mockResolvedValue(page([]));
    const { unmount } = renderList();
    expect(await screen.findByText(t.empty)).toBeInTheDocument();
    unmount();

    currentSearch = "action=USER_LOGIN";
    renderList();
    expect(await screen.findByText(t.emptyFiltered)).toBeInTheDocument();
  });

  it("reports a failure and lets the user retry", async () => {
    getAuditLogs.mockRejectedValueOnce(new Error("boom"));
    renderList();

    expect(await screen.findByRole("alert")).toHaveTextContent(t.loadError);
    await userEvent.click(screen.getByRole("button", { name: tr.common.retry }));

    expect(await screen.findByRole("table", { name: t.tableLabel })).toBeInTheDocument();
  });
});
