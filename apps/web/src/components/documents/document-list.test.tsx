import type { DocumentListItemDto, PaginatedDto } from "@iso-dms/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tr } from "@/lib/i18n/tr";
import { DocumentList } from "./document-list";

const PATHNAME = "/categories/procedures";
const CATEGORY_ID = "cat-1";
const DEPARTMENT_ID = "3f2b8c1e-9a4d-4e6b-8c7f-1a2b3c4d5e6f";

const replace = vi.fn();
let currentSearch = "";
let role = "ADMIN";
const getDocuments = vi.fn();
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
  getDocuments: (query: unknown) => getDocuments(query),
  getDepartments: () => getDepartments(),
}));

function item(overrides: Partial<DocumentListItemDto> = {}): DocumentListItemDto {
  return {
    id: "d1",
    code: "PR-KK-001",
    title: "Doküman Kontrol Prosedürü",
    fileType: "DOCX",
    status: "PUBLISHED",
    categoryId: CATEGORY_ID,
    department: { id: DEPARTMENT_ID, name: "Kalite Koordinatörlüğü", code: "KK" },
    firstPublishedAt: "2025-01-10T09:00:00.000Z",
    revisedAt: "2025-06-01T09:00:00.000Z",
    revisionNo: 2,
    canEdit: false,
    ...overrides,
  };
}

function page(items: DocumentListItemDto[], total = items.length): PaginatedDto<DocumentListItemDto> {
  return { items, total, page: 1, pageSize: 20 };
}

function renderList() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DocumentList categoryId={CATEGORY_ID} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  replace.mockReset();
  getDocuments.mockReset();
  getDepartments.mockReset();
  currentSearch = "";
  role = "ADMIN";
  getDepartments.mockResolvedValue([{ id: DEPARTMENT_ID, name: "Kalite Koordinatörlüğü", code: "KK" }]);
  getDocuments.mockResolvedValue(page([item()]));
});

describe("DocumentList", () => {
  it("renders the documents with formatted dates and revision number", async () => {
    renderList();

    const table = await screen.findByRole("table", { name: tr.documents.tableLabel });
    const row = within(table).getByText("PR-KK-001").closest("tr")!;
    expect(within(row).getByText("Doküman Kontrol Prosedürü")).toBeInTheDocument();
    expect(within(row).getByText("Kalite Koordinatörlüğü")).toBeInTheDocument();
    expect(within(row).getByText("10.01.2025")).toBeInTheDocument();
    expect(within(row).getByText("01.06.2025")).toBeInTheDocument();
    expect(within(row).getByText("2")).toBeInTheDocument();
    expect(within(row).queryByText(tr.documents.status.PUBLISHED)).not.toBeInTheDocument();
  });

  it("offers editing for documents the user may edit and viewing for the others", async () => {
    getDocuments.mockResolvedValue(
      page([
        item({ id: "d-edit", code: "PR-KK-001", canEdit: true }),
        item({ id: "d-view", code: "PR-KK-002", canEdit: false }),
      ]),
    );
    renderList();

    const table = await screen.findByRole("table");
    expect(within(table).getByRole("columnheader", { name: tr.documents.columns.actions })).toBeInTheDocument();
    expect(within(table).getByRole("link", { name: tr.documents.actions.edit })).toHaveAttribute("href", "/documents/d-edit/edit");
    expect(within(table).getByRole("link", { name: tr.documents.actions.view })).toHaveAttribute("href", "/documents/d-view/edit");
  });

  it("links the code and the title to the detail page", async () => {
    getDocuments.mockResolvedValue(page([item({ id: "d-1", code: "PR-KK-001", title: "Doküman Kontrol Prosedürü" })]));
    renderList();

    const table = await screen.findByRole("table");
    expect(within(table).getByRole("link", { name: "PR-KK-001" })).toHaveAttribute("href", "/documents/d-1");
    expect(within(table).getByRole("link", { name: "Doküman Kontrol Prosedürü" })).toHaveAttribute("href", "/documents/d-1");
  });

  it("offers a download only for documents that have a revision in force", async () => {
    getDocuments.mockResolvedValue(
      page([
        item({ id: "d-live", code: "PR-KK-001", revisionNo: 2 }),
        item({ id: "d-draft", code: "PR-KK-002", status: "DRAFT", revisionNo: null, canEdit: true }),
      ]),
    );
    renderList();

    const table = await screen.findByRole("table");
    expect(within(table).getByRole("button", { name: `${tr.detail.download} (PR-KK-001)` })).toBeInTheDocument();
    expect(within(table).queryByRole("button", { name: `${tr.detail.download} (PR-KK-002)` })).not.toBeInTheDocument();
  });

  it("does not make the actions column sortable", async () => {
    renderList();
    const table = await screen.findByRole("table");

    const header = within(table).getByRole("columnheader", { name: tr.documents.columns.actions });
    expect(within(header).queryByRole("button")).not.toBeInTheDocument();
    expect(header).not.toHaveAttribute("aria-sort");
  });

  it("shows a status badge for non-published documents and dashes for missing values", async () => {
    getDocuments.mockResolvedValue(
      page([item({ status: "WITHDRAWN", firstPublishedAt: null, revisedAt: null, revisionNo: null })]),
    );
    renderList();

    const table = await screen.findByRole("table");
    expect(within(table).getByText(tr.documents.status.WITHDRAWN)).toBeInTheDocument();
    expect(within(table).getAllByText("-")).toHaveLength(3);
  });

  it("requests the page described by the URL", async () => {
    currentSearch = `q=form&department=${DEPARTMENT_ID}&status=DRAFT&sort=title&order=desc&page=2`;
    renderList();

    await screen.findByRole("table");
    expect(getDocuments).toHaveBeenCalledWith({
      categoryId: CATEGORY_ID,
      search: "form",
      departmentId: DEPARTMENT_ID,
      status: "DRAFT",
      sortBy: "title",
      sortOrder: "desc",
      page: 2,
      pageSize: 20,
    });
  });

  it("hides the status filter from readers but offers it to other roles", async () => {
    role = "READER";
    const { unmount } = renderList();
    await screen.findByRole("table");
    expect(screen.queryByLabelText(tr.documents.statusFilter)).not.toBeInTheDocument();
    unmount();

    role = "EDITOR";
    renderList();
    await screen.findByRole("table");
    expect(screen.getByLabelText(tr.documents.statusFilter)).toBeInTheDocument();
  });

  it("updates the URL after the search box settles and resets to the first page", async () => {
    currentSearch = "page=3";
    getDocuments.mockResolvedValue(page([item()], 45));
    renderList();
    await screen.findByRole("table");

    await userEvent.type(screen.getByLabelText(tr.documents.searchLabel), "tetkik");

    await waitFor(() => expect(replace).toHaveBeenCalledTimes(1));
    expect(replace).toHaveBeenCalledWith(`${PATHNAME}?q=tetkik`, { scroll: false });
  });

  it("filters by department through the URL", async () => {
    renderList();
    await screen.findByRole("table");
    await screen.findByRole("option", { name: "Kalite Koordinatörlüğü" });

    await userEvent.selectOptions(screen.getByLabelText(tr.documents.departmentFilter), DEPARTMENT_ID);

    expect(replace).toHaveBeenCalledWith(`${PATHNAME}?department=${DEPARTMENT_ID}`, { scroll: false });
  });

  it("sorts ascending on a new column and toggles the direction on the active one", async () => {
    renderList();
    const table = await screen.findByRole("table");

    await userEvent.click(within(table).getByRole("button", { name: tr.documents.columns.title }));
    expect(replace).toHaveBeenLastCalledWith(`${PATHNAME}?sort=title`, { scroll: false });

    await userEvent.click(within(table).getByRole("button", { name: tr.documents.columns.code }));
    expect(replace).toHaveBeenLastCalledWith(`${PATHNAME}?order=desc`, { scroll: false });
  });

  it("marks the sorted column for assistive technology", async () => {
    currentSearch = "sort=revisedAt&order=desc";
    renderList();
    const table = await screen.findByRole("table");

    const header = within(table).getByRole("columnheader", { name: tr.documents.columns.revisedAt });
    expect(header).toHaveAttribute("aria-sort", "descending");
    expect(within(table).getByRole("columnheader", { name: tr.documents.columns.code })).toHaveAttribute(
      "aria-sort",
      "none",
    );
  });

  it("paginates", async () => {
    getDocuments.mockResolvedValue(page([item()], 45));
    renderList();

    expect(await screen.findByText(tr.documents.pageOf(1, 3))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: new RegExp(tr.documents.previousPage) })).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: new RegExp(tr.documents.nextPage) }));
    expect(replace).toHaveBeenCalledWith(`${PATHNAME}?page=2`, { scroll: false });
  });

  it("shows no pagination for a single page", async () => {
    renderList();
    await screen.findByRole("table");
    expect(screen.queryByRole("navigation", { name: tr.documents.pagination })).not.toBeInTheDocument();
  });

  it("jumps to the last page when the URL points past it", async () => {
    currentSearch = "page=9";
    getDocuments.mockResolvedValue({ items: [], total: 45, page: 9, pageSize: 20 });
    renderList();

    await waitFor(() => expect(replace).toHaveBeenCalledWith(`${PATHNAME}?page=3`, { scroll: false }));
  });

  it("shows the empty state of an unfiltered category", async () => {
    getDocuments.mockResolvedValue(page([]));
    renderList();

    expect(await screen.findByText(tr.documents.empty)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: tr.documents.clearFilters })).not.toBeInTheDocument();
  });

  it("shows a different empty state when filters are active and lets the user clear them", async () => {
    currentSearch = "q=zzz";
    getDocuments.mockResolvedValue(page([]));
    renderList();

    expect(await screen.findByText(tr.documents.emptyFiltered)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: tr.documents.clearFilters }));
    expect(replace).toHaveBeenCalledWith(PATHNAME, { scroll: false });
  });

  it("shows an error with a retry button", async () => {
    getDocuments.mockRejectedValueOnce(new Error("boom"));
    renderList();

    expect(await screen.findByRole("alert")).toHaveTextContent(tr.documents.error);

    getDocuments.mockResolvedValueOnce(page([item()]));
    await userEvent.click(screen.getByRole("button", { name: tr.common.retry }));
    expect(await screen.findByRole("table")).toBeInTheDocument();
  });
});
