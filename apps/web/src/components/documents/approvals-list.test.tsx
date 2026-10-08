import type { PaginatedDto, PendingApprovalDto } from "@iso-dms/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tr } from "@/lib/i18n/tr";
import { documentDetail } from "@/test/fixtures";
import { ApprovalsGate } from "./approvals-gate";
import { ApprovalsList } from "./approvals-list";

const t = tr.approvals;
const getPendingApprovals = vi.fn();
const decideApproval = vi.fn();
let role = "APPROVER";

vi.mock("@/lib/auth/auth-context", () => ({
  useAuth: () => ({ status: "authenticated", user: { id: "u1", role }, login: vi.fn(), logout: vi.fn() }),
}));
vi.mock("@/lib/api/endpoints", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/endpoints")>()),
  getPendingApprovals: (page: number) => getPendingApprovals(page),
  decideApproval: (stepId: string, decision: string, comment?: string) => decideApproval(stepId, decision, comment),
}));

function item(overrides: Partial<PendingApprovalDto> = {}): PendingApprovalDto {
  return {
    stepId: "step-1",
    stepOrder: 1,
    approverRole: "APPROVER",
    request: { id: "req-1", type: "REVISION", reason: "Madde 4 eklendi", createdAt: "2025-06-01T09:30:00.000Z", requestedBy: { id: "user-1", fullName: "Ece Editör" } },
    document: { id: "doc-1", code: "PR-KK-001", title: "Doküman Kontrol Prosedürü", department: { id: "dep-kk", name: "Kalite Koordinatörlüğü", code: "KK" } },
    revision: { id: "rev-3", revisionNo: 3, changeSummary: "Madde 4 eklendi" },
    ...overrides,
  };
}

function page(items: PendingApprovalDto[], total = items.length): PaginatedDto<PendingApprovalDto> {
  return { items, total, page: 1, pageSize: 20 };
}

function renderWith(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

/** The desktop table; the mobile list shows the same items. */
const table = () => screen.getByRole("table", { name: t.tableLabel });

beforeEach(() => {
  getPendingApprovals.mockReset();
  decideApproval.mockReset();
  role = "APPROVER";
  getPendingApprovals.mockResolvedValue(page([item()]));
  decideApproval.mockResolvedValue(documentDetail());
});

describe("ApprovalsList", () => {
  it("shows what waits for the user: document, revision, kind, step, sender and date", async () => {
    renderWith(<ApprovalsList />);
    expect(screen.getByRole("status")).toHaveTextContent(tr.common.loading);

    const row = within(await screen.findByRole("table", { name: t.tableLabel })).getAllByRole("row")[1];

    expect(within(row).getByRole("link", { name: "PR-KK-001" })).toHaveAttribute("href", "/documents/doc-1");
    expect(within(row).getByText("Doküman Kontrol Prosedürü")).toBeInTheDocument();
    expect(within(row).getByText("Kalite Koordinatörlüğü")).toBeInTheDocument();
    expect(within(row).getByText(tr.approval.revision(3))).toBeInTheDocument();
    expect(within(row).getByText(tr.approval.type.REVISION)).toBeInTheDocument();
    expect(within(row).getByText(tr.approval.step(1))).toBeInTheDocument();
    expect(within(row).getByText("Ece Editör")).toBeInTheDocument();
    expect(within(row).getByText("01.06.2025 12:30")).toBeInTheDocument();
    expect(screen.getByText(t.total(1))).toBeInTheDocument();
    expect(getPendingApprovals).toHaveBeenCalledWith(1);
  });

  it("shows why: the change summary of a revision, the reason of a withdrawal", async () => {
    getPendingApprovals.mockResolvedValue(
      page([
        item(),
        item({
          stepId: "step-2",
          request: { id: "req-2", type: "WITHDRAWAL", reason: "Süreç artık kullanılmıyor", createdAt: "2025-06-02T09:30:00.000Z", requestedBy: { id: "user-1", fullName: "Ece Editör" } },
        }),
      ]),
    );
    renderWith(<ApprovalsList />);

    const rows = within(await screen.findByRole("table", { name: t.tableLabel })).getAllByRole("row").slice(1);

    expect(within(rows[0]).getByText("Madde 4 eklendi")).toBeInTheDocument();
    expect(within(rows[0]).getByText(`${tr.approval.summaryLabel}:`)).toBeInTheDocument();
    expect(within(rows[1]).getByText("Süreç artık kullanılmıyor")).toBeInTheDocument();
    expect(within(rows[1]).getByText(`${tr.approval.reasonLabel}:`)).toBeInTheDocument();
    expect(within(rows[1]).getByText(tr.approval.type.WITHDRAWAL)).toBeInTheDocument();
  });

  it("asks about a withdrawal in the words of a withdrawal", async () => {
    getPendingApprovals.mockResolvedValue(
      page([item({ request: { id: "req-2", type: "WITHDRAWAL", reason: "Süreç artık kullanılmıyor", createdAt: "2025-06-02T09:30:00.000Z", requestedBy: { id: "user-1", fullName: "Ece Editör" } } })]),
    );
    renderWith(<ApprovalsList />);
    const row = within(await screen.findByRole("table", { name: t.tableLabel })).getAllByRole("row")[1];

    await userEvent.click(within(row).getByRole("button", { name: new RegExp(tr.approval.approve) }));

    expect(within(screen.getByRole("dialog")).getByText(tr.decide.approveWithdrawalConfirm("PR-KK-001"))).toBeInTheDocument();
  });

  it("offers the same items as cards on small screens", async () => {
    renderWith(<ApprovalsList />);
    await screen.findByRole("table", { name: t.tableLabel });

    const cards = within(screen.getByRole("list", { name: t.tableLabel })).getAllByRole("listitem");

    expect(cards).toHaveLength(1);
    expect(within(cards[0]).getByRole("button", { name: new RegExp(tr.approval.approve) })).toBeInTheDocument();
  });

  it("links to the revision under review", async () => {
    renderWith(<ApprovalsList />);
    const row = within(await screen.findByRole("table", { name: t.tableLabel })).getAllByRole("row")[1];

    expect(within(row).getByRole("link", { name: new RegExp(tr.approval.review) })).toHaveAttribute("href", "/documents/doc-1/edit?revision=rev-3");
  });

  it("approves from the list, then asks again for what is left", async () => {
    getPendingApprovals.mockResolvedValueOnce(page([item()])).mockResolvedValue(page([]));
    renderWith(<ApprovalsList />);
    const row = within(await screen.findByRole("table", { name: t.tableLabel })).getAllByRole("row")[1];

    await userEvent.click(within(row).getByRole("button", { name: new RegExp(tr.approval.approve) }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: tr.decide.submitApprove }));

    await waitFor(() => expect(decideApproval).toHaveBeenCalledWith("step-1", "approve", undefined));
    expect(await screen.findByText(t.empty)).toBeInTheDocument();
  });

  it("rejects from the list with a reason", async () => {
    renderWith(<ApprovalsList />);
    const row = within(await screen.findByRole("table", { name: t.tableLabel })).getAllByRole("row")[1];

    await userEvent.click(within(row).getByRole("button", { name: new RegExp(tr.approval.reject) }));
    await userEvent.type(within(screen.getByRole("dialog")).getByLabelText(tr.decide.reason), "Madde 2 eksik");
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: tr.decide.submitReject }));

    await waitFor(() => expect(decideApproval).toHaveBeenCalledWith("step-1", "reject", "Madde 2 eksik"));
  });

  it("pages through a long list", async () => {
    getPendingApprovals.mockResolvedValue({ items: [item()], total: 45, page: 1, pageSize: 20 });
    renderWith(<ApprovalsList />);
    await screen.findByRole("table", { name: t.tableLabel });

    expect(screen.getByText(tr.documents.pageOf(1, 3))).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: tr.documents.nextPage }));

    await waitFor(() => expect(getPendingApprovals).toHaveBeenLastCalledWith(2));
  });

  it("says so when nothing waits", async () => {
    getPendingApprovals.mockResolvedValue(page([]));
    renderWith(<ApprovalsList />);
    expect(await screen.findByText(t.empty)).toBeInTheDocument();
  });

  it("reports a failure and lets the user retry", async () => {
    getPendingApprovals.mockRejectedValueOnce(new Error("boom"));
    renderWith(<ApprovalsList />);

    expect(await screen.findByRole("alert")).toHaveTextContent(t.loadError);
    await userEvent.click(screen.getByRole("button", { name: tr.common.retry }));

    expect(await screen.findByRole("table", { name: t.tableLabel })).toBeInTheDocument();
  });
});

describe("ApprovalsGate", () => {
  it.each(["APPROVER", "QUALITY_MANAGER", "ADMIN"])("lets %s see the list", async (who) => {
    role = who;
    renderWith(<ApprovalsGate />);
    expect(await screen.findByRole("table", { name: t.tableLabel })).toBeInTheDocument();
  });

  it.each(["READER", "EDITOR"])("does not ask the API for %s", (who) => {
    role = who;
    renderWith(<ApprovalsGate />);

    expect(screen.getByRole("alert")).toHaveTextContent(t.forbidden);
    expect(getPendingApprovals).not.toHaveBeenCalled();
    expect(table).toThrow();
  });
});
