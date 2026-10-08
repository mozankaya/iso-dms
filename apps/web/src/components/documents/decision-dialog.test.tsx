import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { tr } from "@/lib/i18n/tr";
import { documentDetail } from "@/test/fixtures";
import { DecisionDialog, type DecisionTarget } from "./decision-dialog";

const t = tr.decide;
const decideApproval = vi.fn();

vi.mock("@/lib/api/endpoints", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/endpoints")>()),
  decideApproval: (stepId: string, decision: string, comment?: string) => decideApproval(stepId, decision, comment),
}));

const target = (mode: DecisionTarget["mode"]): DecisionTarget => ({ stepId: "step-1", mode, documentId: "doc-1", code: "PR-KK-001", revisionNo: 2 });

function renderDialog(current: DecisionTarget | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const onClose = vi.fn();
  const view = render(
    <QueryClientProvider client={client}>
      <DecisionDialog target={current} onClose={onClose} />
    </QueryClientProvider>,
  );
  return { invalidate, onClose, view, client };
}

const dialog = () => screen.getByRole("dialog");
const field = (label: string) => within(dialog()).getByLabelText(label);

beforeEach(() => {
  decideApproval.mockReset();
  decideApproval.mockResolvedValue(documentDetail());
});

describe("DecisionDialog", () => {
  it("shows nothing without a target", () => {
    renderDialog(null);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  describe("approving", () => {
    it("says what is approved and asks for an optional comment", () => {
      renderDialog(target("approve"));

      expect(within(dialog()).getByRole("heading", { name: t.approveTitle })).toBeInTheDocument();
      expect(within(dialog()).getByText(t.approveConfirm("PR-KK-001", 2))).toBeInTheDocument();
      expect(field(t.comment)).toHaveValue("");
    });

    it("approves without a comment", async () => {
      const { onClose, invalidate } = renderDialog(target("approve"));

      await userEvent.click(within(dialog()).getByRole("button", { name: t.submitApprove }));

      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(decideApproval).toHaveBeenCalledWith("step-1", "approve", undefined);
      const keys = invalidate.mock.calls.map(([filter]) => (filter as { queryKey: string[] }).queryKey);
      expect(keys).toEqual(expect.arrayContaining([["document", "doc-1"], ["approvals-pending"], ["documents"]]));
    });

    it("sends the trimmed comment", async () => {
      renderDialog(target("approve"));
      await userEvent.type(field(t.comment), "  Uygundur  ");

      await userEvent.click(within(dialog()).getByRole("button", { name: t.submitApprove }));

      await waitFor(() => expect(decideApproval).toHaveBeenCalledWith("step-1", "approve", "Uygundur"));
    });
  });

  describe("a withdrawal", () => {
    it("is approved in the words of a withdrawal, with the same comment rules", async () => {
      const { onClose } = renderDialog({ ...target("approve"), type: "WITHDRAWAL" });
      expect(within(dialog()).getByText(t.approveWithdrawalConfirm("PR-KK-001"))).toBeInTheDocument();

      await userEvent.click(within(dialog()).getByRole("button", { name: t.submitApprove }));

      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(decideApproval).toHaveBeenCalledWith("step-1", "approve", undefined);
    });

    it("is refused in the words of a withdrawal, and needs a reason", async () => {
      renderDialog({ ...target("reject"), type: "WITHDRAWAL" });
      expect(within(dialog()).getByText(t.rejectWithdrawalConfirm("PR-KK-001"))).toBeInTheDocument();

      await userEvent.click(within(dialog()).getByRole("button", { name: t.submitReject }));

      expect(await within(dialog()).findByRole("alert")).toHaveTextContent(t.reasonRequired);
      expect(decideApproval).not.toHaveBeenCalled();
    });
  });

  describe("rejecting", () => {
    it("says that the draft goes back and asks for a reason", () => {
      renderDialog(target("reject"));

      expect(within(dialog()).getByRole("heading", { name: t.rejectTitle })).toBeInTheDocument();
      expect(within(dialog()).getByText(t.rejectConfirm("PR-KK-001", 2))).toBeInTheDocument();
      expect(field(t.reason)).toHaveValue("");
    });

    it.each([
      ["nothing", ""],
      ["only spaces", "   "],
    ])("does not call the API when %s is written", async (_label, text) => {
      renderDialog(target("reject"));
      if (text) await userEvent.type(field(t.reason), text);

      await userEvent.click(within(dialog()).getByRole("button", { name: t.submitReject }));

      expect(await within(dialog()).findByRole("alert")).toHaveTextContent(t.reasonRequired);
      expect(field(t.reason)).toBeInvalid();
      expect(decideApproval).not.toHaveBeenCalled();
    });

    it("rejects with the reason", async () => {
      const { onClose } = renderDialog(target("reject"));
      await userEvent.type(field(t.reason), "Madde 2 eksik");

      await userEvent.click(within(dialog()).getByRole("button", { name: t.submitReject }));

      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(decideApproval).toHaveBeenCalledWith("step-1", "reject", "Madde 2 eksik");
    });
  });

  it.each([
    ["STEP_ALREADY_DECIDED", 409],
    ["APPROVAL_STEP_NOT_ACTIVE", 409],
    ["APPROVAL_NOT_ALLOWED", 403],
    ["OWN_REVISION_NOT_APPROVABLE", 403],
    ["APPROVAL_NOT_PENDING", 409],
  ] as const)("keeps the dialog open and shows the refusal %s", async (code, status) => {
    decideApproval.mockRejectedValue(new ApiError(status, code, "refused"));
    const { onClose } = renderDialog(target("approve"));

    await userEvent.click(within(dialog()).getByRole("button", { name: t.submitApprove }));

    const alert = await within(dialog()).findByRole("alert");
    expect(alert).toHaveTextContent(tr.errors[code]);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("says so when the server cannot be reached", async () => {
    decideApproval.mockRejectedValue(new TypeError("failed to fetch"));
    renderDialog(target("approve"));

    await userEvent.click(within(dialog()).getByRole("button", { name: t.submitApprove }));

    expect(await within(dialog()).findByRole("alert")).toHaveTextContent(tr.errors.NETWORK);
  });

  it("shows progress and blocks a second click while saving", async () => {
    let finish: (value: unknown) => void = () => undefined;
    decideApproval.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const { onClose } = renderDialog(target("approve"));

    await userEvent.click(within(dialog()).getByRole("button", { name: t.submitApprove }));

    expect(await within(dialog()).findByRole("button", { name: t.submitting })).toBeDisabled();
    finish(documentDetail());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(decideApproval).toHaveBeenCalledTimes(1);
  });

  it("closes on cancel and decides nothing", async () => {
    const { onClose } = renderDialog(target("approve"));

    await userEvent.click(within(dialog()).getByRole("button", { name: t.cancel }));

    expect(onClose).toHaveBeenCalled();
    expect(decideApproval).not.toHaveBeenCalled();
  });

  it("starts clean for the next target: no old comment, no old error", async () => {
    const { view, onClose, client } = renderDialog(target("reject"));
    await userEvent.type(field(t.reason), "Eski gerekçe");
    await userEvent.click(within(dialog()).getByRole("button", { name: t.cancel }));
    expect(onClose).toHaveBeenCalled();

    view.rerender(
      <QueryClientProvider client={client}>
        <DecisionDialog target={{ ...target("reject"), stepId: "step-2" }} onClose={onClose} />
      </QueryClientProvider>,
    );

    expect(field(t.reason)).toHaveValue("");
    expect(within(dialog()).queryByRole("alert")).not.toBeInTheDocument();
  });
});
