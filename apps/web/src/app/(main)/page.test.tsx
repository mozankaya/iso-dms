import type { DashboardStatsDto } from "@iso-dms/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tr } from "@/lib/i18n/tr";
import DashboardPage from "./page";

const t = tr.dashboard;
const getDashboardStats = vi.fn();
const getCategories = vi.fn();

vi.mock("@/lib/api/endpoints", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/endpoints")>()),
  getDashboardStats: () => getDashboardStats(),
  getCategories: () => getCategories(),
}));

const everything: DashboardStatsDto = { totalDocuments: 12, newlyPublished: 3, revised: 2, withdrawn: 1, awaitingApproval: 4 };

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DashboardPage />
    </QueryClientProvider>,
  );
}

const counters = () => screen.getByRole("region", { name: t.countersLabel });

beforeEach(() => {
  getDashboardStats.mockReset();
  getCategories.mockReset();
  getDashboardStats.mockResolvedValue(everything);
  getCategories.mockResolvedValue([]);
});

describe("the dashboard counters", () => {
  it("shows every counter with its number", async () => {
    renderPage();
    expect(await within(counters()).findByText(t.totalDocuments)).toBeInTheDocument();

    const items = within(counters()).getAllByRole("listitem");
    expect(items.map((entry) => entry.textContent)).toEqual([
      `${t.totalDocuments}12`,
      `${t.newlyPublished}3${t.lastDays(30)}`,
      `${t.revised}2${t.lastDays(30)}`,
      `${t.withdrawn}1${t.lastDays(30)}`,
      `${t.awaitingApproval}4${t.waitingForYou}`,
    ]);
  });

  it("leads each counter to the list it counts", async () => {
    renderPage();
    await within(counters()).findByText(t.totalDocuments);

    const link = (label: string) => within(counters()).getByRole("link", { name: new RegExp(label) });
    expect(link(t.newlyPublished)).toHaveAttribute("href", "/lists/new");
    expect(link(t.revised)).toHaveAttribute("href", "/lists/revised");
    expect(link(t.withdrawn)).toHaveAttribute("href", "/lists/withdrawn");
    expect(link(t.awaitingApproval)).toHaveAttribute("href", "/approvals");
    expect(within(counters()).queryByRole("link", { name: new RegExp(t.totalDocuments) })).not.toBeInTheDocument();
  });

  it("leaves out the counters the role has no business with", async () => {
    getDashboardStats.mockResolvedValue({ totalDocuments: 12, newlyPublished: 3, revised: 2, withdrawn: null, awaitingApproval: null });
    renderPage();
    await within(counters()).findByText(t.totalDocuments);

    expect(within(counters()).getAllByRole("listitem")).toHaveLength(3);
    expect(within(counters()).queryByText(t.withdrawn)).not.toBeInTheDocument();
    expect(within(counters()).queryByText(t.awaitingApproval)).not.toBeInTheDocument();
  });

  it("shows a counter that is zero, which is not the same as one that is missing", async () => {
    getDashboardStats.mockResolvedValue({ ...everything, withdrawn: 0, awaitingApproval: 0 });
    renderPage();
    await within(counters()).findByText(t.withdrawn);

    expect(within(counters()).getByText(t.withdrawn).parentElement).toHaveTextContent(`${t.withdrawn}0`);
    expect(within(counters()).getByText(t.awaitingApproval)).toBeInTheDocument();
  });

  it("shows a loading message first", () => {
    renderPage();
    expect(within(counters()).getByText(tr.common.loading)).toBeInTheDocument();
  });

  it("reports a failure and lets the user retry", async () => {
    getDashboardStats.mockRejectedValueOnce(new Error("boom"));
    renderPage();

    expect(await within(counters()).findByRole("alert")).toHaveTextContent(t.statsError);
    await userEvent.click(within(counters()).getByRole("button", { name: tr.common.retry }));

    expect(await within(counters()).findByText(t.newlyPublished)).toBeInTheDocument();
  });
});
