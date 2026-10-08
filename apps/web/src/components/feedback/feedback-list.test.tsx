import type { FeedbackDto, PaginatedDto } from "@iso-dms/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { tr } from "@/lib/i18n/tr";
import { FeedbackList } from "./feedback-list";

const t = tr.feedback.page;
const PATHNAME = "/feedback";
const DEPARTMENT_ID = "3f2b8c1e-9a4d-4e6b-8c7f-1a2b3c4d5e6f";

const replace = vi.fn();
let currentSearch = "";
let role = "QUALITY_MANAGER";
const getFeedback = vi.fn();
const getDepartments = vi.fn();
const resolveFeedback = vi.fn();
const reopenFeedback = vi.fn();

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
  getFeedback: (query: unknown) => getFeedback(query),
  getDepartments: () => getDepartments(),
  resolveFeedback: (id: string, note?: string) => resolveFeedback(id, note),
  reopenFeedback: (id: string) => reopenFeedback(id),
}));

function item(overrides: Partial<FeedbackDto> = {}): FeedbackDto {
  return {
    id: "fb-1",
    message: "Madde 3 anlaşılmıyor",
    createdAt: "2025-06-01T09:30:00.000Z",
    user: { id: "u2", fullName: "Reyhan Okur", department: { id: DEPARTMENT_ID, name: "Kalite Koordinatörlüğü", code: "KK" } },
    document: { id: "doc-1", code: "PR-KK-001", title: "Doküman Kontrol Prosedürü" },
    revisionNo: 2,
    isResolved: false,
    resolvedAt: null,
    resolvedBy: null,
    resolutionNote: null,
    ...overrides,
  };
}

const resolved = item({
  id: "fb-2",
  isResolved: true,
  resolvedAt: "2025-06-03T09:00:00.000Z",
  resolvedBy: { id: "u3", fullName: "Kemal Kalite" },
  resolutionNote: "Madde 3 yeniden yazıldı",
});

function page(items: FeedbackDto[], total = items.length): PaginatedDto<FeedbackDto> {
  return { items, total, page: 1, pageSize: 20 };
}

function renderList() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  render(
    <QueryClientProvider client={client}>
      <FeedbackList />
    </QueryClientProvider>,
  );
  return { invalidate };
}

const table = () => screen.getByRole("table", { name: t.tableLabel });
const firstRow = () => within(table()).getAllByRole("row")[1];

beforeEach(() => {
  replace.mockReset();
  getFeedback.mockReset();
  getDepartments.mockReset();
  resolveFeedback.mockReset();
  reopenFeedback.mockReset();
  currentSearch = "";
  role = "QUALITY_MANAGER";
  getDepartments.mockResolvedValue([{ id: DEPARTMENT_ID, name: "Kalite Koordinatörlüğü", code: "KK" }]);
  getFeedback.mockResolvedValue(page([item()]));
  resolveFeedback.mockResolvedValue(resolved);
  reopenFeedback.mockResolvedValue(item());
});

describe("FeedbackList", () => {
  it("asks for the open feedback by default and shows each one with who, what and about which revision", async () => {
    renderList();
    expect(screen.getByRole("status")).toHaveTextContent(tr.common.loading);

    await screen.findByRole("table", { name: t.tableLabel });

    expect(getFeedback).toHaveBeenCalledWith({ status: "open", period: "all", departmentId: undefined, search: undefined, page: 1, pageSize: 20 });
    expect(screen.getByText(t.total(1))).toBeInTheDocument();
    const row = firstRow();
    expect(within(row).getByText("01.06.2025 12:30")).toBeInTheDocument();
    expect(within(row).getByText("Reyhan Okur")).toBeInTheDocument();
    expect(within(row).getByText("Kalite Koordinatörlüğü")).toBeInTheDocument();
    expect(within(row).getByRole("link", { name: /PR-KK-001/ })).toHaveAttribute("href", "/documents/doc-1");
    expect(within(row).getByRole("link", { name: /PR-KK-001/ })).toHaveTextContent(tr.audit.revision(2));
    expect(within(row).getByText("Doküman Kontrol Prosedürü")).toBeInTheDocument();
    expect(within(row).getByText("Madde 3 anlaşılmıyor")).toBeInTheDocument();
    expect(within(row).getByText(t.open)).toBeInTheDocument();
  });

  it("does not even ask the API when the user may not read feedback", () => {
    role = "EDITOR";
    renderList();

    expect(screen.getByRole("alert")).toHaveTextContent(t.forbidden);
    expect(getFeedback).not.toHaveBeenCalled();
    expect(getDepartments).not.toHaveBeenCalled();
  });

  it.each(["QUALITY_MANAGER", "ADMIN"])("lets %s in", async (who) => {
    role = who;
    renderList();
    expect(await screen.findByRole("table", { name: t.tableLabel })).toBeInTheDocument();
  });

  it("offers the same feedback as cards on small screens", async () => {
    renderList();
    await screen.findByRole("table", { name: t.tableLabel });

    const cards = within(screen.getByRole("list", { name: t.tableLabel })).getAllByRole("listitem");

    expect(cards).toHaveLength(1);
    expect(within(cards[0]).getByText("Madde 3 anlaşılmıyor")).toBeInTheDocument();
    expect(within(cards[0]).getByRole("button", { name: t.resolve })).toBeInTheDocument();
  });

  describe("closed feedback", () => {
    it("shows who closed it, when, and the note, and offers to reopen it", async () => {
      getFeedback.mockResolvedValue(page([resolved]));
      renderList();
      await screen.findByRole("table", { name: t.tableLabel });

      const row = firstRow();
      expect(within(row).getByText(t.statuses.resolved)).toBeInTheDocument();
      expect(within(row).getByText(t.resolvedBy("Kemal Kalite", "03.06.2025"))).toBeInTheDocument();
      expect(within(row).getByText("Madde 3 yeniden yazıldı")).toBeInTheDocument();
      expect(within(row).getByRole("button", { name: t.reopen })).toBeInTheDocument();
      expect(within(row).queryByRole("button", { name: t.resolve })).not.toBeInTheDocument();
    });

    it("reopens it and refreshes the list, the counter and the history", async () => {
      getFeedback.mockResolvedValue(page([resolved]));
      const { invalidate } = renderList();
      await screen.findByRole("table", { name: t.tableLabel });

      await userEvent.click(within(firstRow()).getByRole("button", { name: t.reopen }));

      await waitFor(() => expect(reopenFeedback).toHaveBeenCalledWith("fb-2"));
      const keys = invalidate.mock.calls.map(([filter]) => (filter as { queryKey: string[] }).queryKey);
      await waitFor(() => expect(keys).toEqual(expect.arrayContaining([["feedback"], ["dashboard-stats"], ["audit-logs"]])));
    });

    it("shows the refusal when somebody changed it meanwhile", async () => {
      getFeedback.mockResolvedValue(page([resolved]));
      reopenFeedback.mockRejectedValue(new ApiError(409, "FEEDBACK_NOT_RESOLVED", "open already"));
      renderList();
      await screen.findByRole("table", { name: t.tableLabel });

      await userEvent.click(within(firstRow()).getByRole("button", { name: t.reopen }));

      expect(await screen.findByRole("alert")).toHaveTextContent(tr.errors.FEEDBACK_NOT_RESOLVED);
    });
  });

  describe("closing", () => {
    const dialog = () => screen.getByRole("dialog");

    it("asks for an optional note, shows what is being closed, and sends the trimmed note", async () => {
      const { invalidate } = renderList();
      await screen.findByRole("table", { name: t.tableLabel });

      await userEvent.click(within(firstRow()).getByRole("button", { name: t.resolve }));
      expect(within(dialog()).getByText(tr.feedback.resolveDialog.confirm("PR-KK-001"))).toBeInTheDocument();
      expect(within(dialog()).getByText("Madde 3 anlaşılmıyor")).toBeInTheDocument();
      await userEvent.type(within(dialog()).getByLabelText(tr.feedback.resolveDialog.note), "  Madde 3 yeniden yazıldı  ");
      await userEvent.click(within(dialog()).getByRole("button", { name: tr.feedback.resolveDialog.submit }));

      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(resolveFeedback).toHaveBeenCalledWith("fb-1", "Madde 3 yeniden yazıldı");
      const keys = invalidate.mock.calls.map(([filter]) => (filter as { queryKey: string[] }).queryKey);
      expect(keys).toEqual(expect.arrayContaining([["feedback"], ["dashboard-stats"], ["audit-logs"]]));
    });

    it("closes without a note", async () => {
      renderList();
      await screen.findByRole("table", { name: t.tableLabel });

      await userEvent.click(within(firstRow()).getByRole("button", { name: t.resolve }));
      await userEvent.click(within(dialog()).getByRole("button", { name: tr.feedback.resolveDialog.submit }));

      await waitFor(() => expect(resolveFeedback).toHaveBeenCalledWith("fb-1", undefined));
    });

    it("keeps the dialog open and shows the refusal", async () => {
      resolveFeedback.mockRejectedValue(new ApiError(409, "FEEDBACK_ALREADY_RESOLVED", "closed already"));
      renderList();
      await screen.findByRole("table", { name: t.tableLabel });
      await userEvent.click(within(firstRow()).getByRole("button", { name: t.resolve }));

      await userEvent.click(within(dialog()).getByRole("button", { name: tr.feedback.resolveDialog.submit }));

      expect(await within(dialog()).findByRole("alert")).toHaveTextContent(tr.errors.FEEDBACK_ALREADY_RESOLVED);
    });

    it("closes on cancel and changes nothing, and is empty the next time", async () => {
      renderList();
      await screen.findByRole("table", { name: t.tableLabel });
      await userEvent.click(within(firstRow()).getByRole("button", { name: t.resolve }));
      await userEvent.type(within(dialog()).getByLabelText(tr.feedback.resolveDialog.note), "Yarım kalan not");

      await userEvent.click(within(dialog()).getByRole("button", { name: tr.feedback.resolveDialog.cancel }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(resolveFeedback).not.toHaveBeenCalled();

      await userEvent.click(within(firstRow()).getByRole("button", { name: t.resolve }));
      expect(within(dialog()).getByLabelText(tr.feedback.resolveDialog.note)).toHaveValue("");
    });
  });

  describe("filters", () => {
    it("reads them from the URL", async () => {
      currentSearch = `q=PR-KK&department=${DEPARTMENT_ID}&status=resolved&period=30&page=2`;
      getFeedback.mockResolvedValue({ items: [resolved], total: 45, page: 2, pageSize: 20 });
      renderList();
      await screen.findByRole("table", { name: t.tableLabel });

      expect(getFeedback).toHaveBeenCalledWith({ status: "resolved", period: "30", departmentId: DEPARTMENT_ID, search: "PR-KK", page: 2, pageSize: 20 });
      expect(screen.getByLabelText(t.searchLabel)).toHaveValue("PR-KK");
      expect(screen.getByLabelText(t.statusFilter)).toHaveValue("resolved");
      expect(screen.getByLabelText(t.departmentFilter)).toHaveValue(DEPARTMENT_ID);
      expect(screen.getByLabelText(t.period)).toHaveValue("30");
    });

    it("puts a chosen status into the URL, and goes back to the first page", async () => {
      currentSearch = "page=3";
      getFeedback.mockResolvedValue({ items: [item()], total: 60, page: 3, pageSize: 20 });
      renderList();
      await screen.findByRole("table", { name: t.tableLabel });

      await userEvent.selectOptions(screen.getByLabelText(t.statusFilter), "all");

      expect(replace).toHaveBeenLastCalledWith(`${PATHNAME}?status=all`, { scroll: false });
    });

    it("puts the department and the period into the URL", async () => {
      renderList();
      await screen.findByRole("table", { name: t.tableLabel });

      await userEvent.selectOptions(screen.getByLabelText(t.departmentFilter), DEPARTMENT_ID);
      expect(replace).toHaveBeenLastCalledWith(`${PATHNAME}?department=${DEPARTMENT_ID}`, { scroll: false });
      await userEvent.selectOptions(screen.getByLabelText(t.period), "7");
      expect(replace).toHaveBeenLastCalledWith(`${PATHNAME}?period=7`, { scroll: false });
    });

    it("waits for a pause in typing before it searches", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        renderList();
        await screen.findByRole("table", { name: t.tableLabel });

        fireEvent.change(screen.getByLabelText(t.searchLabel), { target: { value: "  Madde  " } });
        expect(replace).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(350);
        expect(replace).toHaveBeenLastCalledWith(`${PATHNAME}?q=Madde`, { scroll: false });
      } finally {
        vi.useRealTimers();
      }
    });

    it("clears them all at once, and only offers it when something is filtered", async () => {
      renderList();
      await screen.findByRole("table", { name: t.tableLabel });
      expect(screen.queryByRole("button", { name: t.clearFilters })).not.toBeInTheDocument();
    });

    it("counts a status other than the default as a filter, and clears it", async () => {
      currentSearch = "status=all&q=abc";
      renderList();
      await screen.findByRole("table", { name: t.tableLabel });

      await userEvent.click(screen.getByRole("button", { name: t.clearFilters }));

      expect(replace).toHaveBeenLastCalledWith(PATHNAME, { scroll: false });
      expect(screen.getByLabelText(t.searchLabel)).toHaveValue("");
    });
  });

  describe("pages", () => {
    it("pages through a long list", async () => {
      getFeedback.mockResolvedValue({ items: [item()], total: 45, page: 1, pageSize: 20 });
      renderList();
      await screen.findByRole("table", { name: t.tableLabel });

      expect(screen.getByText(tr.documents.pageOf(1, 3))).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: tr.documents.nextPage }));

      expect(replace).toHaveBeenLastCalledWith(`${PATHNAME}?page=2`, { scroll: false });
    });

    it("moves to the last page when the link points past it", async () => {
      currentSearch = "page=9";
      getFeedback.mockResolvedValue({ items: [item()], total: 45, page: 9, pageSize: 20 });
      renderList();

      await waitFor(() => expect(replace).toHaveBeenCalledWith(`${PATHNAME}?page=3`, { scroll: false }));
    });
  });

  it("says so when there is nothing, with the words of what was asked for", async () => {
    getFeedback.mockResolvedValue(page([]));
    renderList();
    expect(await screen.findByText(t.emptyOpen)).toBeInTheDocument();
  });

  it("says so when no feedback exists at all, or the filters leave nothing", async () => {
    currentSearch = "status=all";
    getFeedback.mockResolvedValue(page([]));
    renderList();
    expect(await screen.findByText(t.emptyFiltered)).toBeInTheDocument();
  });

  it("reports a failure and lets the user retry", async () => {
    getFeedback.mockRejectedValueOnce(new Error("boom"));
    renderList();

    expect(await screen.findByRole("alert")).toHaveTextContent(t.loadError);
    await userEvent.click(screen.getByRole("button", { name: tr.common.retry }));

    expect(await screen.findByRole("table", { name: t.tableLabel })).toBeInTheDocument();
  });
});
