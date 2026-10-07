import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { tr } from "@/lib/i18n/tr";
import { documentDetail } from "@/test/fixtures";
import { CancelRevisionButton } from "./cancel-revision-button";

const t = tr.cancelRevision;
const cancelRevision = vi.fn();

vi.mock("@/lib/api/endpoints", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/endpoints")>()),
  cancelRevision: (revisionId: string, reason: string) => cancelRevision(revisionId, reason),
}));

const revision = { id: "rev-3", revisionNo: 3, status: "DRAFT" as const, changeSummary: "Madde 4" };

function renderButton() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  render(
    <QueryClientProvider client={client}>
      <CancelRevisionButton documentId="doc-1" code="PR-KK-001" revision={revision} />
    </QueryClientProvider>,
  );
  return { invalidate };
}

const dialog = () => screen.getByRole("dialog");
const field = () => within(dialog()).getByLabelText(t.reason);
const submit = () => userEvent.click(within(dialog()).getByRole("button", { name: t.submit }));

beforeEach(() => {
  cancelRevision.mockReset();
  cancelRevision.mockResolvedValue(documentDetail());
});

describe("CancelRevisionButton", () => {
  it("only shows the button until it is clicked, and explains what giving up means", async () => {
    renderButton();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: t.button }));

    expect(within(dialog()).getByRole("heading", { name: t.dialogTitle })).toBeInTheDocument();
    expect(within(dialog()).getByText(t.confirm("PR-KK-001", 3))).toBeInTheDocument();
    expect(field()).toHaveValue("");
    expect(cancelRevision).not.toHaveBeenCalled();
  });

  it.each([
    ["nothing", ""],
    ["only spaces", "   "],
  ])("does not call the API when %s is written", async (_label, text) => {
    renderButton();
    await userEvent.click(screen.getByRole("button", { name: t.button }));
    if (text) await userEvent.type(field(), text);

    await submit();

    expect(await within(dialog()).findByRole("alert")).toHaveTextContent(t.reasonRequired);
    expect(field()).toBeInvalid();
    expect(cancelRevision).not.toHaveBeenCalled();
  });

  it("gives up with the trimmed reason, closes and refreshes everything that shows the document", async () => {
    const { invalidate } = renderButton();
    await userEvent.click(screen.getByRole("button", { name: t.button }));
    await userEvent.type(field(), "  Artık gerekli değil  ");

    await submit();

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(cancelRevision).toHaveBeenCalledWith("rev-3", "Artık gerekli değil");
    const keys = invalidate.mock.calls.map(([filter]) => (filter as { queryKey: string[] }).queryKey);
    expect(keys).toEqual(expect.arrayContaining([["document", "doc-1"], ["revisions", "doc-1"], ["documents"]]));
  });

  it.each([
    ["REVISION_NOT_CANCELLABLE", 409],
    ["EDITOR_SESSION_ACTIVE", 409],
    ["CANCEL_NOT_ALLOWED", 403],
  ] as const)("keeps the dialog open and shows the refusal %s", async (code, status) => {
    cancelRevision.mockRejectedValue(new ApiError(status, code, "refused"));
    renderButton();
    await userEvent.click(screen.getByRole("button", { name: t.button }));
    await userEvent.type(field(), "Artık gerekli değil");

    await submit();

    expect(await within(dialog()).findByRole("alert")).toHaveTextContent(tr.errors[code]);
    expect(field()).toHaveValue("Artık gerekli değil");
  });

  it("says so when the server cannot be reached", async () => {
    cancelRevision.mockRejectedValue(new TypeError("failed to fetch"));
    renderButton();
    await userEvent.click(screen.getByRole("button", { name: t.button }));
    await userEvent.type(field(), "Artık gerekli değil");

    await submit();

    expect(await within(dialog()).findByRole("alert")).toHaveTextContent(tr.errors.NETWORK);
  });

  it("closes on cancel and gives up nothing, and is empty the next time", async () => {
    renderButton();
    await userEvent.click(screen.getByRole("button", { name: t.button }));
    await userEvent.type(field(), "Artık gerekli değil");

    await userEvent.click(within(dialog()).getByRole("button", { name: t.cancel }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(cancelRevision).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: t.button }));
    expect(field()).toHaveValue("");
  });
});
