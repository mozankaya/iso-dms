import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { tr } from "@/lib/i18n/tr";
import { documentDetail } from "@/test/fixtures";
import { PublishButton } from "./publish-button";

const t = tr.publish;
const publishRevision = vi.fn();

vi.mock("@/lib/api/endpoints", () => ({
  publishRevision: (id: string, summary?: string) => publishRevision(id, summary),
}));

let client: QueryClient;

function renderButton(revisionNo = 0) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  render(
    <QueryClientProvider client={client}>
      <PublishButton documentId="doc-1" code="PR-KK-001" revision={{ id: "rev-1", revisionNo, status: "DRAFT" }} />
    </QueryClientProvider>,
  );
  return { invalidate };
}

const openDialog = () => userEvent.click(screen.getByRole("button", { name: t.button }));
const dialog = () => screen.getByRole("dialog");
const confirm = () => userEvent.click(within(dialog()).getByRole("button", { name: t.submit }));

beforeEach(() => {
  publishRevision.mockReset();
  publishRevision.mockResolvedValue(documentDetail({ status: "PUBLISHED" }));
});

describe("PublishButton", () => {
  it("only shows the button until it is clicked", () => {
    renderButton();

    expect(screen.getByRole("button", { name: t.button })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("asks for confirmation and says that the revision cannot be edited afterwards", async () => {
    renderButton();

    await openDialog();

    expect(within(dialog()).getByRole("heading", { name: t.dialogTitle })).toBeInTheDocument();
    expect(within(dialog()).getByText(t.confirm("PR-KK-001", 0))).toBeInTheDocument();
    expect(publishRevision).not.toHaveBeenCalled();
  });

  describe("the first revision", () => {
    it("publishes without asking for a change summary", async () => {
      renderButton(0);
      await openDialog();
      expect(within(dialog()).queryByLabelText(t.changeSummary)).not.toBeInTheDocument();

      await confirm();

      await waitFor(() => expect(publishRevision).toHaveBeenCalledWith("rev-1", undefined));
    });

    it("closes the dialog and refreshes everything that shows the document", async () => {
      const { invalidate } = renderButton();
      await openDialog();

      await confirm();

      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      const keys = invalidate.mock.calls.map(([filter]) => (filter as { queryKey: string[] }).queryKey);
      expect(keys).toEqual(
        expect.arrayContaining([["document", "doc-1"], ["revisions", "doc-1"], ["documents"], ["categories"], ["dashboard-stats"]]),
      );
    });
  });

  describe("later revisions", () => {
    it("require a change summary and do not call the API without one", async () => {
      renderButton(2);
      await openDialog();

      await confirm();

      expect(await within(dialog()).findByRole("alert")).toHaveTextContent(t.changeSummaryRequired);
      expect(publishRevision).not.toHaveBeenCalled();
    });

    it("does not accept a summary that is only spaces", async () => {
      renderButton(2);
      await openDialog();
      await userEvent.type(within(dialog()).getByLabelText(t.changeSummary), "    ");

      await confirm();

      expect(await within(dialog()).findByRole("alert")).toHaveTextContent(t.changeSummaryRequired);
      expect(publishRevision).not.toHaveBeenCalled();
    });

    it("send the trimmed summary", async () => {
      renderButton(2);
      await openDialog();
      await userEvent.type(within(dialog()).getByLabelText(t.changeSummary), "  Madde 3 güncellendi  ");

      await confirm();

      await waitFor(() => expect(publishRevision).toHaveBeenCalledWith("rev-1", "Madde 3 güncellendi"));
    });
  });

  describe("when the server refuses", () => {
    it.each([
      ["somebody is still editing", new ApiError(409, "EDITOR_SESSION_ACTIVE"), tr.errors.EDITOR_SESSION_ACTIVE],
      ["the editor server is down", new ApiError(503, "EDITOR_SERVER_UNAVAILABLE"), tr.errors.EDITOR_SERVER_UNAVAILABLE],
      ["the revision is no longer a draft", new ApiError(409, "REVISION_NOT_PUBLISHABLE"), tr.errors.REVISION_NOT_PUBLISHABLE],
      ["the summary is missing", new ApiError(400, "CHANGE_SUMMARY_REQUIRED"), tr.errors.CHANGE_SUMMARY_REQUIRED],
      ["the user may not publish", new ApiError(403, "FORBIDDEN"), tr.errors.FORBIDDEN],
      ["the connection fails", new TypeError("fetch failed"), tr.errors.NETWORK],
    ])("explains in Turkish and keeps the dialog open when %s", async (_label, failure, message) => {
      const { invalidate } = renderButton();
      publishRevision.mockRejectedValueOnce(failure);
      await openDialog();

      await confirm();

      expect(await within(dialog()).findByRole("alert")).toHaveTextContent(message);
      expect(within(dialog()).getByRole("button", { name: t.submit })).toBeEnabled();
      expect(invalidate).not.toHaveBeenCalled();
    });

    it("lets the user try again after closing the editor", async () => {
      renderButton();
      publishRevision.mockRejectedValueOnce(new ApiError(409, "EDITOR_SESSION_ACTIVE"));
      await openDialog();
      await confirm();
      await within(dialog()).findByRole("alert");

      await confirm();

      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(publishRevision).toHaveBeenCalledTimes(2);
    });
  });

  it("shows progress and blocks a second click while publishing", async () => {
    renderButton();
    let finish: (value: unknown) => void = () => undefined;
    publishRevision.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    await openDialog();

    await confirm();

    const submit = await within(dialog()).findByRole("button", { name: t.submitting });
    expect(submit).toBeDisabled();
    expect(within(dialog()).getByRole("button", { name: t.cancel })).toBeDisabled();
    finish(documentDetail());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(publishRevision).toHaveBeenCalledTimes(1);
  });

  describe("leaving without publishing", () => {
    it("closes on cancel and publishes nothing", async () => {
      renderButton();
      await openDialog();

      await userEvent.click(within(dialog()).getByRole("button", { name: t.cancel }));

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(publishRevision).not.toHaveBeenCalled();
    });

    it("closes when the browser closes the dialog (Escape)", async () => {
      renderButton();
      await openDialog();

      fireEvent(dialog(), new Event("close"));

      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });

    it("starts clean the next time: no old error, no old summary", async () => {
      renderButton(2);
      await openDialog();
      await userEvent.type(within(dialog()).getByLabelText(t.changeSummary), "eski metin");
      publishRevision.mockRejectedValueOnce(new ApiError(409, "EDITOR_SESSION_ACTIVE"));
      await confirm();
      await within(dialog()).findByRole("alert");
      await userEvent.click(within(dialog()).getByRole("button", { name: t.cancel }));

      await openDialog();

      expect(within(dialog()).queryByRole("alert")).not.toBeInTheDocument();
      expect(within(dialog()).getByLabelText(t.changeSummary)).toHaveValue("");
    });
  });
});
