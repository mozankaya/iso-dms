import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { tr } from "@/lib/i18n/tr";
import { documentDetail } from "@/test/fixtures";
import { ReviewActions } from "./review-actions";

const t = tr.review;
const markDocumentReviewed = vi.fn();
const updateReviewSettings = vi.fn();

vi.mock("@/lib/api/endpoints", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/endpoints")>()),
  markDocumentReviewed: (id: string, note?: string) => markDocumentReviewed(id, note),
  updateReviewSettings: (id: string, months: number | null) => updateReviewSettings(id, months),
}));

function renderActions(overrides = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  render(
    <QueryClientProvider client={client}>
      <ReviewActions document={documentDetail({ canMarkReviewed: true, canSetReviewInterval: true, ...overrides })} />
    </QueryClientProvider>,
  );
  return { invalidate };
}

const keysOf = (invalidate: { mock: { calls: unknown[][] } }) => invalidate.mock.calls.map((call) => (call[0] as { queryKey: string[] }).queryKey[0]);

beforeEach(() => {
  markDocumentReviewed.mockReset();
  updateReviewSettings.mockReset();
});

describe("ReviewActions", () => {
  it("shows nothing to those who answer for nothing", () => {
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <ReviewActions document={documentDetail({ canMarkReviewed: false, canSetReviewInterval: false })} />
      </QueryClientProvider>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("offers only what the user may do", () => {
    renderActions({ canMarkReviewed: false });
    expect(screen.queryByRole("button", { name: t.reviewed })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: t.setInterval })).toBeInTheDocument();
  });

  it("asks before saying a document was reviewed, sends the note, and refreshes everything that shows the dates", async () => {
    markDocumentReviewed.mockResolvedValue(documentDetail());
    const { invalidate } = renderActions();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: t.reviewed }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(t.reviewedConfirm("PR-KK-001"))).toBeInTheDocument();
    expect(markDocumentReviewed).not.toHaveBeenCalled();
    await user.type(within(dialog).getByLabelText(t.note), "  Madde 3 güncel ");
    await user.click(within(dialog).getByRole("button", { name: t.reviewedSubmit }));

    await waitFor(() => expect(markDocumentReviewed).toHaveBeenCalledWith("doc-1", "Madde 3 güncel"));
    await waitFor(() => expect(keysOf(invalidate)).toEqual(expect.arrayContaining(["document", "documents", "review-due", "dashboard-stats", "audit-logs"])));
  });

  it("sends no note when none was written", async () => {
    markDocumentReviewed.mockResolvedValue(documentDetail());
    renderActions();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: t.reviewed }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: t.reviewedSubmit }));

    await waitFor(() => expect(markDocumentReviewed).toHaveBeenCalledWith("doc-1", undefined));
  });

  it("shows the reason the API gives in Turkish", async () => {
    markDocumentReviewed.mockRejectedValue(new ApiError(409, "DOCUMENT_NOT_REVIEWABLE"));
    renderActions();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: t.reviewed }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: t.reviewedSubmit }));

    expect(await screen.findByRole("alert")).toHaveTextContent(tr.errors.DOCUMENT_NOT_REVIEWABLE);
  });

  it("starts the period dialog with the period the document has, and sends the new one", async () => {
    updateReviewSettings.mockResolvedValue(documentDetail());
    renderActions({ reviewIntervalMonths: 12 });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: t.setInterval }));
    const input = within(screen.getByRole("dialog")).getByLabelText(t.intervalLabel);
    expect(input).toHaveValue("12");
    await user.clear(input);
    await user.type(input, "6");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: t.save }));

    await waitFor(() => expect(updateReviewSettings).toHaveBeenCalledWith("doc-1", 6));
  });

  it("removes the period when the field is emptied", async () => {
    updateReviewSettings.mockResolvedValue(documentDetail());
    renderActions({ reviewIntervalMonths: 12 });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: t.setInterval }));
    await user.clear(within(screen.getByRole("dialog")).getByLabelText(t.intervalLabel));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: t.save }));

    await waitFor(() => expect(updateReviewSettings).toHaveBeenCalledWith("doc-1", null));
  });

  it.each(["0", "121", "1.5", "abc"])("does not send the period %s", async (value) => {
    renderActions({ reviewIntervalMonths: null });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: t.setInterval }));
    await user.type(within(screen.getByRole("dialog")).getByLabelText(t.intervalLabel), value);
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: t.save }));

    expect(screen.getByText(t.intervalInvalid(1, 120))).toBeInTheDocument();
    expect(updateReviewSettings).not.toHaveBeenCalled();
  });
});
