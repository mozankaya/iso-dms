import type { ApprovalRequestDto, ApprovalStepDto } from "@iso-dms/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { tr } from "@/lib/i18n/tr";
import { documentDetail } from "@/test/fixtures";
import { ApprovalPanel } from "./approval-panel";

const t = tr.approval;
const cancelApprovalRequest = vi.fn();
const decideApproval = vi.fn();

vi.mock("@/lib/api/endpoints", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/endpoints")>()),
  cancelApprovalRequest: (requestId: string) => cancelApprovalRequest(requestId),
  decideApproval: (stepId: string, decision: string, comment?: string) => decideApproval(stepId, decision, comment),
}));

function step(overrides: Partial<ApprovalStepDto> = {}): ApprovalStepDto {
  return {
    id: "step-1",
    stepOrder: 1,
    approverRole: "APPROVER",
    decision: "PENDING",
    approver: null,
    comment: null,
    decidedAt: null,
    canDecide: false,
    ...overrides,
  };
}

function approval(overrides: Partial<ApprovalRequestDto> = {}): ApprovalRequestDto {
  return {
    id: "req-1",
    type: "REVISION",
    status: "PENDING",
    revision: { id: "rev-3", revisionNo: 3 },
    requestedBy: { id: "user-1", fullName: "Ece Editör" },
    createdAt: "2025-06-01T09:30:00.000Z",
    resolvedAt: null,
    steps: [step(), step({ id: "step-2", stepOrder: 2, approverRole: "QUALITY_MANAGER" })],
    canCancel: false,
    ...overrides,
  };
}

function renderPanel(request: ApprovalRequestDto | null, overrides: Parameters<typeof documentDetail>[0] = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  render(
    <QueryClientProvider client={client}>
      <ApprovalPanel document={documentDetail({ approval: request, ...overrides })} />
    </QueryClientProvider>,
  );
  return { invalidate };
}

beforeEach(() => {
  cancelApprovalRequest.mockReset();
  decideApproval.mockReset();
  cancelApprovalRequest.mockResolvedValue(documentDetail());
  decideApproval.mockResolvedValue(documentDetail());
});

describe("ApprovalPanel", () => {
  it("shows nothing for a document without an approval", () => {
    renderPanel(null);
    expect(screen.queryByRole("heading", { name: t.title })).not.toBeInTheDocument();
  });

  it("shows what the request is about, who sent it and when", () => {
    renderPanel(approval());

    expect(screen.getByRole("heading", { name: t.title })).toBeInTheDocument();
    expect(screen.getByText(t.revision(3))).toBeInTheDocument();
    expect(screen.getByText(`(${t.type.REVISION})`)).toBeInTheDocument();
    expect(screen.getByText(t.status.PENDING)).toBeInTheDocument();
    expect(screen.getByText(t.requestedBy("Ece Editör", "01.06.2025 12:30"))).toBeInTheDocument();
  });

  it("lists the steps in order with their roles and state", () => {
    renderPanel(
      approval({
        steps: [
          step({ decision: "APPROVED", approver: { id: "user-2", fullName: "Onur Onaylayıcı" }, decidedAt: "2025-06-02T08:00:00.000Z", comment: "Uygundur" }),
          step({ id: "step-2", stepOrder: 2, approverRole: "QUALITY_MANAGER" }),
        ],
      }),
    );

    const items = within(screen.getByRole("list", { name: t.title })).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent(`${t.step(1)} · ${t.roles.APPROVER}`);
    expect(items[0]).toHaveTextContent(t.decision.APPROVED);
    expect(items[0]).toHaveTextContent(t.decidedBy("Onur Onaylayıcı", "02.06.2025 11:00"));
    expect(items[0]).toHaveTextContent("Uygundur");
    expect(items[1]).toHaveTextContent(`${t.step(2)} · ${t.roles.QUALITY_MANAGER}`);
    expect(items[1]).toHaveTextContent(t.decision.PENDING);
  });

  it("offers a way to look at the revision under review", () => {
    renderPanel(approval(), { id: "doc-1" });
    expect(screen.getByRole("link", { name: t.review })).toHaveAttribute("href", "/documents/doc-1/edit?revision=rev-3");
  });

  it("does not offer it once the request is closed", () => {
    renderPanel(approval({ status: "APPROVED" }));
    expect(screen.queryByRole("link", { name: t.review })).not.toBeInTheDocument();
  });

  describe("deciding", () => {
    it("offers approving and rejecting only on the step that is the user's turn", () => {
      renderPanel(approval({ steps: [step({ canDecide: true }), step({ id: "step-2", stepOrder: 2, approverRole: "QUALITY_MANAGER" })] }));

      expect(screen.getAllByRole("button", { name: t.approve })).toHaveLength(1);
      expect(screen.getAllByRole("button", { name: t.reject })).toHaveLength(1);
    });

    it("offers nothing to those who have no step", () => {
      renderPanel(approval());
      expect(screen.queryByRole("button", { name: t.approve })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: t.reject })).not.toBeInTheDocument();
    });

    it("approves through the dialog and refreshes the document", async () => {
      const { invalidate } = renderPanel(approval({ steps: [step({ canDecide: true }), step({ id: "step-2", stepOrder: 2, approverRole: "QUALITY_MANAGER" })] }));

      await userEvent.click(screen.getByRole("button", { name: t.approve }));
      expect(within(screen.getByRole("dialog")).getByText(tr.decide.approveConfirm("PR-KK-001", 3))).toBeInTheDocument();
      await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: tr.decide.submitApprove }));

      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(decideApproval).toHaveBeenCalledWith("step-1", "approve", undefined);
      const keys = invalidate.mock.calls.map(([filter]) => (filter as { queryKey: string[] }).queryKey);
      expect(keys).toEqual(expect.arrayContaining([["document", "doc-1"], ["approvals-pending"]]));
    });

    it("rejects through the dialog, with the reason", async () => {
      renderPanel(approval({ steps: [step({ canDecide: true }), step({ id: "step-2", stepOrder: 2, approverRole: "QUALITY_MANAGER" })] }));

      await userEvent.click(screen.getByRole("button", { name: t.reject }));
      await userEvent.type(within(screen.getByRole("dialog")).getByLabelText(tr.decide.reason), "Madde 2 eksik");
      await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: tr.decide.submitReject }));

      await waitFor(() => expect(decideApproval).toHaveBeenCalledWith("step-1", "reject", "Madde 2 eksik"));
    });
  });

  describe("taking the request back", () => {
    it("is offered only to those who may", () => {
      renderPanel(approval());
      expect(screen.queryByRole("button", { name: t.cancel })).not.toBeInTheDocument();
    });

    it("asks first, then takes the request back and refreshes the document", async () => {
      const { invalidate } = renderPanel(approval({ canCancel: true }));

      await userEvent.click(screen.getByRole("button", { name: t.cancel }));
      const dialog = screen.getByRole("dialog");
      expect(within(dialog).getByText(t.cancelConfirm)).toBeInTheDocument();
      expect(cancelApprovalRequest).not.toHaveBeenCalled();
      await userEvent.click(within(dialog).getByRole("button", { name: t.cancelSubmit }));

      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(cancelApprovalRequest).toHaveBeenCalledWith("req-1");
      const keys = invalidate.mock.calls.map(([filter]) => (filter as { queryKey: string[] }).queryKey);
      expect(keys).toEqual(expect.arrayContaining([["document", "doc-1"], ["revisions", "doc-1"]]));
    });

    it("shows the refusal when somebody decided meanwhile", async () => {
      cancelApprovalRequest.mockRejectedValue(new ApiError(409, "REQUEST_NOT_CANCELLABLE", "refused"));
      renderPanel(approval({ canCancel: true }));
      await userEvent.click(screen.getByRole("button", { name: t.cancel }));

      await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: t.cancelSubmit }));

      expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent(tr.errors.REQUEST_NOT_CANCELLABLE);
    });

    it("closes without doing anything when the user changes their mind", async () => {
      renderPanel(approval({ canCancel: true }));
      await userEvent.click(screen.getByRole("button", { name: t.cancel }));

      await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: t.close }));

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(cancelApprovalRequest).not.toHaveBeenCalled();
    });
  });

  describe("a rejected request", () => {
    const rejected = approval({
      status: "REJECTED",
      steps: [
        step({ decision: "REJECTED", approver: { id: "user-2", fullName: "Onur Onaylayıcı" }, decidedAt: "2025-06-02T08:00:00.000Z", comment: "Madde 2 eksik" }),
        step({ id: "step-2", stepOrder: 2, approverRole: "QUALITY_MANAGER" }),
      ],
    });

    it("keeps the reason in sight, and tells the authors what to do", () => {
      renderPanel(rejected, { canSubmit: true });

      expect(screen.getByText(t.status.REJECTED)).toBeInTheDocument();
      expect(screen.getByText("Madde 2 eksik")).toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent(t.rejectedNotice);
    });

    it("does not give instructions to those who cannot send the draft", () => {
      renderPanel(rejected, { canSubmit: false });
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });
  });
});
