import type { PaginatedDto, ReviewDueItemDto } from "@iso-dms/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { tr } from "@/lib/i18n/tr";
import { documentListItem } from "@/test/fixtures";
import { ReviewDueList } from "./review-due-list";

const t = tr.reviewDue;
const DEPARTMENT_ID = "3f2b8c1e-9a4d-4e6b-8c7f-1a2b3c4d5e6f";

const replace = vi.fn();
let currentSearch = "";
let role = "QUALITY_MANAGER";
const getReviewDueList = vi.fn();
const getDepartments = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => "/lists/review-due",
  useSearchParams: () => new URLSearchParams(currentSearch),
}));
vi.mock("@/lib/auth/auth-context", () => ({
  useAuth: () => ({ status: "authenticated", user: { id: "u1", role }, login: vi.fn(), logout: vi.fn() }),
}));
vi.mock("@/lib/api/endpoints", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/endpoints")>()),
  getReviewDueList: (query: unknown) => getReviewDueList(query),
  getDepartments: () => getDepartments(),
}));

function item(overrides: Partial<ReviewDueItemDto> = {}): ReviewDueItemDto {
  return { ...documentListItem(), nextReviewAt: "2026-10-20T09:00:00.000Z", overdue: false, owner: { id: "u2", fullName: "Ece Editör" }, ...overrides };
}

function page(items: ReviewDueItemDto[], total = items.length): PaginatedDto<ReviewDueItemDto> {
  return { items, total, page: 1, pageSize: 20 };
}

function renderList() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ReviewDueList />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  currentSearch = "";
  role = "QUALITY_MANAGER";
  getReviewDueList.mockResolvedValue(page([item({ id: "d1", overdue: true, nextReviewAt: "2026-10-01T09:00:00.000Z" }), item({ id: "d2", code: "PR-KK-002" })]));
  getDepartments.mockResolvedValue([{ id: DEPARTMENT_ID, name: "Kalite Koordinatörlüğü", code: "KK" }]);
});

describe("ReviewDueList", () => {
  it("lists the documents with the date, the one responsible, and marks the overdue ones", async () => {
    renderList();

    const table = await screen.findByRole("table", { name: t.tableLabel });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByRole("link", { name: "PR-KK-001" })).toHaveAttribute("href", "/documents/d1");
    expect(within(rows[0]).getByText("Ece Editör")).toBeInTheDocument();
    expect(within(rows[0]).getByText("01.10.2026")).toBeInTheDocument();
    expect(within(rows[0]).getByText(t.overdue)).toBeInTheDocument();
    expect(within(rows[1]).queryByText(t.overdue)).not.toBeInTheDocument();
    expect(screen.getByText(t.total(2))).toBeInTheDocument();
  });

  it("asks for the page and filters the URL names", async () => {
    currentSearch = `q=prosedür&department=${DEPARTMENT_ID}&page=2`;
    getReviewDueList.mockResolvedValue(page([item()], 45));
    renderList();

    await screen.findByRole("table", { name: t.tableLabel });
    expect(getReviewDueList).toHaveBeenCalledWith({ departmentId: DEPARTMENT_ID, search: "prosedür", page: 2, pageSize: 20 });
  });

  it("puts a chosen department into the URL and goes back to the first page", async () => {
    currentSearch = "page=3";
    getReviewDueList.mockResolvedValue(page([item()], 60));
    renderList();
    await screen.findByRole("table", { name: t.tableLabel });

    await userEvent.selectOptions(screen.getByLabelText(t.departmentFilter), DEPARTMENT_ID);

    expect(replace).toHaveBeenCalledWith(`/lists/review-due?department=${DEPARTMENT_ID}`, { scroll: false });
  });

  it("says so when nothing is due, or nothing matches", async () => {
    getReviewDueList.mockResolvedValue(page([]));
    renderList();
    expect(await screen.findByText(t.empty)).toBeInTheDocument();
  });

  it("says nothing matches the filters", async () => {
    currentSearch = "q=yok";
    getReviewDueList.mockResolvedValue(page([]));
    renderList();
    expect(await screen.findByText(t.emptyFiltered)).toBeInTheDocument();
  });

  it("gives readers a message instead of asking for a list they do not have", () => {
    role = "READER";
    renderList();

    expect(screen.getByRole("alert")).toHaveTextContent(t.forbidden);
    expect(getReviewDueList).not.toHaveBeenCalled();
  });

  it("tells when the list cannot be loaded", async () => {
    getReviewDueList.mockRejectedValue(new ApiError(500, "UNKNOWN"));
    renderList();
    expect(await screen.findByRole("alert")).toHaveTextContent(t.loadError);
  });
});
