import type { PaginatedDto, PublicationListItemDto, PublicationListKind } from "@iso-dms/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tr } from "@/lib/i18n/tr";
import { documentListItem } from "@/test/fixtures";
import { PublicationList } from "./publication-list";

const t = tr.lists;
const PATHNAME = "/lists/new";
const DEPARTMENT_ID = "3f2b8c1e-9a4d-4e6b-8c7f-1a2b3c4d5e6f";

const replace = vi.fn();
let currentSearch = "";
let role = "QUALITY_MANAGER";
const getPublicationList = vi.fn();
const getDepartments = vi.fn();

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
  getPublicationList: (kind: string, query: unknown) => getPublicationList(kind, query),
  getDepartments: () => getDepartments(),
}));

function item(overrides: Partial<PublicationListItemDto> = {}): PublicationListItemDto {
  return { ...documentListItem(), withdrawnAt: null, withdrawalReason: null, ...overrides };
}

function page(items: PublicationListItemDto[], total = items.length): PaginatedDto<PublicationListItemDto> {
  return { items, total, page: 1, pageSize: 20 };
}

function renderList(kind: PublicationListKind = "new") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PublicationList kind={kind} />
    </QueryClientProvider>,
  );
}

const table = () => screen.getByRole("table", { name: t.tableLabel });

beforeEach(() => {
  replace.mockReset();
  getPublicationList.mockReset();
  getDepartments.mockReset();
  currentSearch = "";
  role = "QUALITY_MANAGER";
  getDepartments.mockResolvedValue([{ id: DEPARTMENT_ID, name: "Kalite Koordinatörlüğü", code: "KK" }]);
  getPublicationList.mockResolvedValue(page([item()]));
});

describe("PublicationList", () => {
  it("asks for the list of its kind with the default period, and shows the documents", async () => {
    renderList("new");
    expect(screen.getByRole("status")).toHaveTextContent(tr.common.loading);

    await screen.findByRole("table", { name: t.tableLabel });

    expect(getPublicationList).toHaveBeenCalledWith("new", { period: "30", departmentId: undefined, search: undefined, page: 1, pageSize: 20 });
    expect(screen.getByText(t.total(1))).toBeInTheDocument();
    const row = within(table()).getAllByRole("row")[1];
    expect(within(row).getByRole("link", { name: "PR-KK-001" })).toHaveAttribute("href", "/documents/doc-1");
    expect(within(row).getByText("Kalite Koordinatörlüğü")).toBeInTheDocument();
  });

  it.each([
    ["new", "İlk Yayın Tarihi", "10.01.2025"],
    ["revised", "Revizyon Tarihi", "01.06.2025"],
  ] as const)("shows the date the %s list is about", async (kind, header, value) => {
    renderList(kind);
    await screen.findByRole("table", { name: t.tableLabel });

    expect(within(table()).getByRole("columnheader", { name: header })).toBeInTheDocument();
    expect(within(within(table()).getAllByRole("row")[1]).getByText(value)).toBeInTheDocument();
    expect(getPublicationList).toHaveBeenCalledWith(kind, expect.anything());
  });

  describe("the withdrawn list", () => {
    const gone = item({ status: "WITHDRAWN", withdrawnAt: "2025-09-01T09:00:00.000Z", withdrawalReason: "Süreç kalktı" });

    it("shows when and why, and marks the document as invalid", async () => {
      getPublicationList.mockResolvedValue(page([gone]));
      renderList("withdrawn");
      await screen.findByRole("table", { name: t.tableLabel });

      expect(within(table()).getByRole("columnheader", { name: t.kinds.withdrawn.dateColumn })).toBeInTheDocument();
      expect(within(table()).getByRole("columnheader", { name: t.columns.reason })).toBeInTheDocument();
      const row = within(table()).getAllByRole("row")[1];
      expect(within(row).getByText("01.09.2025")).toBeInTheDocument();
      expect(within(row).getByText("Süreç kalktı")).toBeInTheDocument();
      expect(within(row).getByText(tr.documents.status.WITHDRAWN)).toBeInTheDocument();
    });

    it("offers no download of a document that is no longer in force", async () => {
      getPublicationList.mockResolvedValue(page([gone]));
      renderList("withdrawn");
      await screen.findByRole("table", { name: t.tableLabel });

      expect(within(table()).queryByRole("button", { name: new RegExp(tr.detail.download) })).not.toBeInTheDocument();
    });

    it("has no reason column on the other lists", async () => {
      renderList("new");
      await screen.findByRole("table", { name: t.tableLabel });
      expect(within(table()).queryByRole("columnheader", { name: t.columns.reason })).not.toBeInTheDocument();
    });

    it("does not even ask the API when a reader opens it by hand", () => {
      role = "READER";
      renderList("withdrawn");

      expect(screen.getByRole("alert")).toHaveTextContent(t.forbidden);
      expect(getPublicationList).not.toHaveBeenCalled();
    });

    it("lets everybody else in", async () => {
      for (const who of ["EDITOR", "APPROVER", "QUALITY_MANAGER", "ADMIN"]) {
        role = who;
        const { unmount } = renderList("withdrawn");
        expect(await screen.findByRole("table", { name: t.tableLabel })).toBeInTheDocument();
        unmount();
      }
    });
  });

  it("offers the same documents as cards on small screens", async () => {
    renderList("new");
    await screen.findByRole("table", { name: t.tableLabel });

    const cards = within(screen.getByRole("list", { name: t.tableLabel })).getAllByRole("listitem");

    expect(cards).toHaveLength(1);
    expect(within(cards[0]).getByRole("link", { name: "PR-KK-001" })).toBeInTheDocument();
  });

  describe("filters", () => {
    it("reads them from the URL", async () => {
      currentSearch = `q=PR-KK&department=${DEPARTMENT_ID}&period=90&page=2`;
      getPublicationList.mockResolvedValue({ items: [item()], total: 45, page: 2, pageSize: 20 });
      renderList("revised");
      await screen.findByRole("table", { name: t.tableLabel });

      expect(getPublicationList).toHaveBeenCalledWith("revised", { period: "90", departmentId: DEPARTMENT_ID, search: "PR-KK", page: 2, pageSize: 20 });
      expect(screen.getByLabelText(t.searchLabel)).toHaveValue("PR-KK");
      expect(screen.getByLabelText(t.departmentFilter)).toHaveValue(DEPARTMENT_ID);
      expect(screen.getByLabelText(t.period)).toHaveValue("90");
    });

    it("offers every period, and the default one is chosen", async () => {
      renderList();
      await screen.findByRole("table", { name: t.tableLabel });

      const select = screen.getByLabelText(t.period);
      expect(within(select).getAllByRole("option").map((option) => option.textContent)).toEqual([t.periods["7"], t.periods["30"], t.periods["90"], t.periods.all]);
      expect(select).toHaveValue("30");
    });

    it("puts a chosen period into the URL, and goes back to the first page", async () => {
      currentSearch = "page=3";
      getPublicationList.mockResolvedValue({ items: [item()], total: 60, page: 3, pageSize: 20 });
      renderList();
      await screen.findByRole("table", { name: t.tableLabel });

      await userEvent.selectOptions(screen.getByLabelText(t.period), "all");

      expect(replace).toHaveBeenLastCalledWith(`${PATHNAME}?period=all`, { scroll: false });
    });

    it("puts a chosen department into the URL", async () => {
      renderList();
      await screen.findByRole("table", { name: t.tableLabel });

      await userEvent.selectOptions(screen.getByLabelText(t.departmentFilter), DEPARTMENT_ID);

      expect(replace).toHaveBeenLastCalledWith(`${PATHNAME}?department=${DEPARTMENT_ID}`, { scroll: false });
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

    it("clears them all at once, the period included, and only offers it when something is filtered", async () => {
      currentSearch = "q=abc&period=7";
      renderList();
      await screen.findByRole("table", { name: t.tableLabel });

      await userEvent.click(screen.getByRole("button", { name: t.clearFilters }));

      expect(replace).toHaveBeenLastCalledWith(PATHNAME, { scroll: false });
      expect(screen.getByLabelText(t.searchLabel)).toHaveValue("");
    });

    it("offers no clear button when nothing is filtered", async () => {
      renderList();
      await screen.findByRole("table", { name: t.tableLabel });
      expect(screen.queryByRole("button", { name: t.clearFilters })).not.toBeInTheDocument();
    });
  });

  describe("pages", () => {
    it("pages through a long list", async () => {
      getPublicationList.mockResolvedValue({ items: [item()], total: 45, page: 1, pageSize: 20 });
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
      getPublicationList.mockResolvedValue({ items: [item()], total: 45, page: 9, pageSize: 20 });
      renderList();

      await waitFor(() => expect(replace).toHaveBeenCalledWith(`${PATHNAME}?page=3`, { scroll: false }));
    });
  });

  it.each(["new", "revised", "withdrawn"] as const)("says so when the %s list is empty, and when the filters leave nothing", async (kind) => {
    getPublicationList.mockResolvedValue(page([]));
    const { unmount } = renderList(kind);
    expect(await screen.findByText(t.kinds[kind].empty)).toBeInTheDocument();
    unmount();

    currentSearch = "q=abc";
    renderList(kind);
    expect(await screen.findByText(t.emptyFiltered)).toBeInTheDocument();
  });

  it("reports a failure and lets the user retry", async () => {
    getPublicationList.mockRejectedValueOnce(new Error("boom"));
    renderList();

    expect(await screen.findByRole("alert")).toHaveTextContent(t.loadError);
    await userEvent.click(screen.getByRole("button", { name: tr.common.retry }));

    expect(await screen.findByRole("table", { name: t.tableLabel })).toBeInTheDocument();
  });
});
