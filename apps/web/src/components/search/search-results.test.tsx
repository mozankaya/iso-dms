import type { PaginatedDto, SearchResultDto } from "@iso-dms/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { tr } from "@/lib/i18n/tr";
import { documentListItem } from "@/test/fixtures";
import { SearchResults } from "./search-results";

const t = tr.search;
const DEPARTMENT_ID = "3f2b8c1e-9a4d-4e6b-8c7f-1a2b3c4d5e6f";

const replace = vi.fn();
let currentSearch = "";
const searchDocuments = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => "/search",
  useSearchParams: () => new URLSearchParams(currentSearch),
}));
vi.mock("@/lib/api/endpoints", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/endpoints")>()),
  searchDocuments: (query: unknown) => searchDocuments(query),
  getDepartments: () => Promise.resolve([{ id: DEPARTMENT_ID, name: "Kalite Birimi", code: "KK" }]),
  getCategories: () => Promise.resolve([{ id: "cat-1", name: "Prosedürler", slug: "procedures", codePrefix: "PR", icon: null, sortOrder: 1, documentCount: 3 }]),
}));

function result(overrides: Partial<SearchResultDto> = {}): SearchResultDto {
  return {
    ...documentListItem(),
    snippets: [
      [
        { text: "…kayıtların ", match: false },
        { text: "saklama", match: true },
        { text: " süresi dolduğunda imha edilir.", match: false },
      ],
    ],
    ...overrides,
  };
}

function page(items: SearchResultDto[], total = items.length): PaginatedDto<SearchResultDto> {
  return { items, total, page: 1, pageSize: 20 };
}

function renderSearch() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SearchResults />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  currentSearch = "";
  searchDocuments.mockResolvedValue(page([result()]));
});

describe("SearchResults", () => {
  it("asks for nothing until there are words in the address", () => {
    renderSearch();

    expect(screen.getByText(t.start)).toBeInTheDocument();
    expect(searchDocuments).not.toHaveBeenCalled();
  });

  it("does not ask for a single character", () => {
    currentSearch = "q=a";
    renderSearch();

    expect(screen.getByText(t.minLength(2))).toBeInTheDocument();
    expect(searchDocuments).not.toHaveBeenCalled();
  });

  it("shows the documents found with the hit of each marked and a link to the document", async () => {
    currentSearch = "q=saklama";
    renderSearch();

    const list = await screen.findByRole("list", { name: t.resultsLabel });
    const item = within(list).getAllByRole("listitem")[0];
    expect(within(item).getAllByRole("link")[0]).toHaveAttribute("href", "/documents/doc-1");
    expect(within(item).getByText("saklama").tagName).toBe("MARK");
    expect(within(item).getByText(/süresi dolduğunda/).tagName).toBe("SPAN");
    expect(screen.getByText(t.total(1))).toBeInTheDocument();
    expect(searchDocuments).toHaveBeenCalledWith({ q: "saklama", departmentId: undefined, categoryId: undefined, page: 1, pageSize: 20 });
  });

  it("says when only the code or the title matched", async () => {
    searchDocuments.mockResolvedValue(page([result({ snippets: [] })]));
    currentSearch = "q=PR-KK";
    renderSearch();

    expect(await screen.findByText(t.titleOrCodeOnly)).toBeInTheDocument();
  });

  it("says so when nothing was found", async () => {
    searchDocuments.mockResolvedValue(page([]));
    currentSearch = "q=yokboyle";
    renderSearch();

    expect(await screen.findByText(t.empty)).toBeInTheDocument();
  });

  it("puts a new search and a filter in the address and starts again from the first page", async () => {
    currentSearch = "q=saklama&page=3";
    searchDocuments.mockResolvedValue(page([result()], 90));
    renderSearch();
    await screen.findByRole("list", { name: t.resultsLabel });

    await userEvent.selectOptions(screen.getByLabelText(t.departmentFilter), DEPARTMENT_ID);
    expect(replace).toHaveBeenLastCalledWith(`/search?q=saklama&department=${DEPARTMENT_ID}`, { scroll: false });

    const box = screen.getByRole("searchbox", { name: t.wordsLabel });
    await userEvent.clear(box);
    await userEvent.type(box, "imha edilir{Enter}");
    expect(replace).toHaveBeenLastCalledWith("/search?q=imha+edilir", { scroll: false });
  });

  it("fills the box with the words in the address and can clear the filters", async () => {
    currentSearch = `q=saklama&category=${DEPARTMENT_ID}`;
    renderSearch();
    await screen.findByRole("list", { name: t.resultsLabel });

    expect(screen.getByRole("searchbox", { name: t.wordsLabel })).toHaveValue("saklama");
    await userEvent.click(screen.getByRole("button", { name: t.clearFilters }));
    expect(replace).toHaveBeenLastCalledWith("/search?q=saklama", { scroll: false });
  });

  it("pages the results", async () => {
    currentSearch = "q=saklama";
    searchDocuments.mockResolvedValue(page([result()], 45));
    renderSearch();
    await screen.findByRole("list", { name: t.resultsLabel });

    await userEvent.click(screen.getByRole("button", { name: /sonraki/i }));

    expect(replace).toHaveBeenLastCalledWith("/search?q=saklama&page=2", { scroll: false });
  });

  it("shows why a search failed in Turkish and lets the user retry", async () => {
    searchDocuments.mockRejectedValueOnce(new ApiError(400, "SEARCH_QUERY_INVALID")).mockResolvedValue(page([result()]));
    currentSearch = "q=%28%29";
    renderSearch();

    expect(await screen.findByRole("alert")).toHaveTextContent(tr.errors.SEARCH_QUERY_INVALID);
    await userEvent.click(screen.getByRole("button", { name: tr.common.retry }));
    expect(await screen.findByRole("list", { name: t.resultsLabel })).toBeInTheDocument();
  });
});
