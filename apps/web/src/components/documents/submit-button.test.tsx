import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { tr } from "@/lib/i18n/tr";
import { documentDetail } from "@/test/fixtures";
import { SubmitButton } from "./submit-button";

const t = tr.submit;
const submitRevision = vi.fn();

vi.mock("@/lib/api/endpoints", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/endpoints")>()),
  submitRevision: (revisionId: string) => submitRevision(revisionId),
}));

const revision = { id: "rev-1", revisionNo: 2, status: "DRAFT" as const, changeSummary: "Madde 4 eklendi" };

function renderButton(props: { autoOpen?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  render(
    <QueryClientProvider client={client}>
      <SubmitButton documentId="doc-1" code="PR-KK-001" revision={revision} {...props} />
    </QueryClientProvider>,
  );
  return { invalidate };
}

const sessionActive = () => new ApiError(409, "EDITOR_SESSION_ACTIVE", "busy");
const dialog = () => screen.getByRole("dialog");
const submitButton = () => within(dialog()).getByRole("button", { name: t.submit });

beforeEach(() => {
  submitRevision.mockReset();
  submitRevision.mockResolvedValue(documentDetail());
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SubmitButton", () => {
  it("only shows the button until it is clicked, and says what happens when it is", async () => {
    renderButton();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: t.button }));

    expect(within(dialog()).getByRole("heading", { name: t.dialogTitle })).toBeInTheDocument();
    expect(within(dialog()).getByText(t.confirm("PR-KK-001", 2))).toBeInTheDocument();
    expect(submitRevision).not.toHaveBeenCalled();
  });

  it("opens the dialog right away when asked to (the editor sent the author here)", () => {
    renderButton({ autoOpen: true });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("sends the revision, closes, and refreshes everything that shows the document or waiting approvals", async () => {
    const { invalidate } = renderButton();
    await userEvent.click(screen.getByRole("button", { name: t.button }));

    await userEvent.click(submitButton());

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(submitRevision).toHaveBeenCalledTimes(1);
    expect(submitRevision).toHaveBeenCalledWith("rev-1");
    const keys = invalidate.mock.calls.map(([filter]) => (filter as { queryKey: string[] }).queryKey);
    expect(keys).toEqual(
      expect.arrayContaining([["document", "doc-1"], ["revisions", "doc-1"], ["documents"], ["approvals-pending"], ["audit-logs"]]),
    );
  });

  it.each([
    ["REVISION_NOT_SUBMITTABLE", 409],
    ["SUBMIT_NOT_ALLOWED", 403],
    ["EDITOR_SERVER_UNAVAILABLE", 503],
  ] as const)("keeps the dialog open and shows the refusal %s", async (code, status) => {
    submitRevision.mockRejectedValue(new ApiError(status, code, "refused"));
    renderButton();
    await userEvent.click(screen.getByRole("button", { name: t.button }));

    await userEvent.click(submitButton());

    expect(await within(dialog()).findByRole("alert")).toHaveTextContent(tr.errors[code]);
    expect(submitRevision).toHaveBeenCalledTimes(1); // only the editor being busy is tried again
  });

  it("says so when the server cannot be reached", async () => {
    submitRevision.mockRejectedValue(new TypeError("failed to fetch"));
    renderButton();
    await userEvent.click(screen.getByRole("button", { name: t.button }));

    await userEvent.click(submitButton());

    expect(await within(dialog()).findByRole("alert")).toHaveTextContent(tr.errors.NETWORK);
  });

  it("shows progress and blocks a second click while sending", async () => {
    let finish: (value: unknown) => void = () => undefined;
    submitRevision.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    renderButton();
    await userEvent.click(screen.getByRole("button", { name: t.button }));

    await userEvent.click(submitButton());

    expect(await within(dialog()).findByRole("button", { name: t.submitting })).toBeDisabled();
    expect(within(dialog()).getByRole("button", { name: t.cancel })).toBeDisabled();
    await act(async () => finish(documentDetail()));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(submitRevision).toHaveBeenCalledTimes(1);
  });

  describe("while the editor is still saving", () => {
    it("tries again until the last changes are in, and tells the author to wait", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      submitRevision.mockRejectedValueOnce(sessionActive()).mockRejectedValueOnce(sessionActive());
      renderButton();
      await user.click(screen.getByRole("button", { name: t.button }));

      await user.click(submitButton());
      expect(await within(dialog()).findByRole("status")).toHaveTextContent(t.saving);
      expect(within(dialog()).queryByRole("alert")).not.toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2100);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2100);
      });

      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(submitRevision).toHaveBeenCalledTimes(3);
    });

    it("gives up after half a minute and reports it", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      submitRevision.mockRejectedValue(sessionActive());
      renderButton();
      await user.click(screen.getByRole("button", { name: t.button }));

      await user.click(submitButton());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(31_000);
      });

      expect(await within(dialog()).findByRole("alert")).toHaveTextContent(tr.errors.EDITOR_SESSION_ACTIVE);
      expect(within(dialog()).queryByRole("status")).not.toBeInTheDocument();
      expect(submitRevision.mock.calls.length).toBeGreaterThan(5);
      expect(submitRevision.mock.calls.length).toBeLessThan(20);
      expect(submitButton()).toBeEnabled();
    });
  });

  it("closes on cancel and sends nothing", async () => {
    renderButton();
    await userEvent.click(screen.getByRole("button", { name: t.button }));

    await userEvent.click(within(dialog()).getByRole("button", { name: t.cancel }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(submitRevision).not.toHaveBeenCalled();
  });

  it("starts clean the next time: no old error", async () => {
    submitRevision.mockRejectedValueOnce(new ApiError(409, "REVISION_NOT_SUBMITTABLE", "refused"));
    renderButton();
    await userEvent.click(screen.getByRole("button", { name: t.button }));
    await userEvent.click(submitButton());
    await within(dialog()).findByRole("alert");
    await userEvent.click(within(dialog()).getByRole("button", { name: t.cancel }));

    await userEvent.click(screen.getByRole("button", { name: t.button }));

    expect(within(dialog()).queryByRole("alert")).not.toBeInTheDocument();
  });
});
