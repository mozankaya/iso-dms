import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { tr } from "@/lib/i18n/tr";
import { documentDetail } from "@/test/fixtures";
import { StartRevisionButton } from "./start-revision-button";

const t = tr.startRevision;

const push = vi.fn();
const startRevision = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/api/endpoints", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/endpoints")>()),
  startRevision: (documentId: string, changeSummary: string) => startRevision(documentId, changeSummary),
}));

function renderButton() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  render(
    <QueryClientProvider client={client}>
      <StartRevisionButton documentId="doc-1" code="PR-KK-001" />
    </QueryClientProvider>,
  );
  return { invalidate };
}

const openDialog = () => userEvent.click(screen.getByRole("button", { name: t.button }));
const dialog = () => screen.getByRole("dialog");
const field = () => within(dialog()).getByLabelText(t.changeSummary);
const submit = () => userEvent.click(within(dialog()).getByRole("button", { name: t.submit }));

beforeEach(() => {
  push.mockReset();
  startRevision.mockReset();
  startRevision.mockResolvedValue(documentDetail());
});

describe("StartRevisionButton", () => {
  it("only shows the button until it is clicked", () => {
    renderButton();

    expect(screen.getByRole("button", { name: t.button })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("explains what happens and asks what is going to change", async () => {
    renderButton();

    await openDialog();

    expect(within(dialog()).getByRole("heading", { name: t.dialogTitle })).toBeInTheDocument();
    expect(within(dialog()).getByText(t.confirm("PR-KK-001"))).toBeInTheDocument();
    expect(field()).toHaveValue("");
    expect(startRevision).not.toHaveBeenCalled();
  });

  it.each([
    ["nothing", ""],
    ["only spaces", "    "],
  ])("does not call the API when %s is written", async (_label, text) => {
    renderButton();
    await openDialog();
    if (text) await userEvent.type(field(), text);

    await submit();

    expect(await within(dialog()).findByRole("alert")).toHaveTextContent(t.changeSummaryRequired);
    expect(field()).toBeInvalid();
    expect(startRevision).not.toHaveBeenCalled();
  });

  it("starts the revision with the trimmed summary, refreshes what shows the document and opens the editor", async () => {
    const { invalidate } = renderButton();
    await openDialog();
    await userEvent.type(field(), "  Madde 4 eklendi  ");

    await submit();

    await waitFor(() => expect(push).toHaveBeenCalledWith("/documents/doc-1/edit"));
    expect(startRevision).toHaveBeenCalledWith("doc-1", "Madde 4 eklendi");
    const keys = invalidate.mock.calls.map(([filter]) => (filter as { queryKey: string[] }).queryKey);
    expect(keys).toEqual(expect.arrayContaining([["document", "doc-1"], ["revisions", "doc-1"], ["documents"]]));
  });

  it.each([
    ["REVISION_ALREADY_OPEN", 409],
    ["DOCUMENT_NOT_REVISABLE", 409],
    ["REVISION_START_NOT_ALLOWED", 403],
    ["REVISION_FILE_MISSING", 404],
  ] as const)("keeps the dialog open and shows the refusal %s", async (code, status) => {
    startRevision.mockRejectedValue(new ApiError(status, code, "refused"));
    renderButton();
    await openDialog();
    await userEvent.type(field(), "Madde 4 eklendi");

    await submit();

    expect(await within(dialog()).findByRole("alert")).toHaveTextContent(tr.errors[code]);
    expect(push).not.toHaveBeenCalled();
    expect(field()).toHaveValue("Madde 4 eklendi");
  });

  it("says so when the server cannot be reached", async () => {
    startRevision.mockRejectedValue(new TypeError("failed to fetch"));
    renderButton();
    await openDialog();
    await userEvent.type(field(), "Madde 4 eklendi");

    await submit();

    expect(await within(dialog()).findByRole("alert")).toHaveTextContent(tr.errors.NETWORK);
  });

  it("shows progress and blocks a second click while starting", async () => {
    let finish: (value: unknown) => void = () => undefined;
    startRevision.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    renderButton();
    await openDialog();
    await userEvent.type(field(), "Madde 4 eklendi");

    await submit();

    const busy = await within(dialog()).findByRole("button", { name: t.submitting });
    expect(busy).toBeDisabled();
    expect(within(dialog()).getByRole("button", { name: t.cancel })).toBeDisabled();
    finish(documentDetail());
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(startRevision).toHaveBeenCalledTimes(1);
  });

  it("closes on cancel and starts nothing, and is empty the next time", async () => {
    renderButton();
    await openDialog();
    await userEvent.type(field(), "Madde 4 eklendi");

    await userEvent.click(within(dialog()).getByRole("button", { name: t.cancel }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(startRevision).not.toHaveBeenCalled();

    await openDialog();
    expect(field()).toHaveValue("");
  });
});
