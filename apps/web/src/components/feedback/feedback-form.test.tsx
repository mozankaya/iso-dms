import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { tr } from "@/lib/i18n/tr";
import { FeedbackForm } from "./feedback-form";

const t = tr.feedback;
const sendFeedback = vi.fn();

vi.mock("@/lib/api/endpoints", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/endpoints")>()),
  sendFeedback: (documentId: string, message: string) => sendFeedback(documentId, message),
}));

function renderForm() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  render(
    <QueryClientProvider client={client}>
      <FeedbackForm documentId="doc-1" />
    </QueryClientProvider>,
  );
  return { invalidate };
}

const field = () => screen.getByLabelText(t.label);
const submit = () => userEvent.click(screen.getByRole("button", { name: t.submit }));

beforeEach(() => {
  sendFeedback.mockReset();
  sendFeedback.mockResolvedValue({ id: "fb-1", createdAt: "2025-06-01T09:30:00.000Z" });
});

describe("FeedbackForm", () => {
  it("shows what it is for and an empty box", () => {
    renderForm();

    expect(screen.getByRole("heading", { name: t.title })).toBeInTheDocument();
    expect(screen.getByText(t.sectionHint)).toBeInTheDocument();
    expect(field()).toHaveValue("");
    expect(sendFeedback).not.toHaveBeenCalled();
  });

  it.each([
    ["nothing", ""],
    ["only spaces", "     "],
    ["two characters", "ab"],
  ])("does not call the API when %s is written", async (_label, text) => {
    renderForm();
    if (text) await userEvent.type(field(), text);

    await submit();

    expect(await screen.findByRole("alert")).toHaveTextContent(t.tooShort(3));
    expect(field()).toBeInvalid();
    expect(sendFeedback).not.toHaveBeenCalled();
  });

  it("sends the trimmed message, empties the box, says it arrived and refreshes what depends on it", async () => {
    const { invalidate } = renderForm();
    await userEvent.type(field(), "  Madde 3 anlaşılmıyor  ");

    await submit();

    expect(await screen.findByRole("status")).toHaveTextContent(t.sent);
    expect(sendFeedback).toHaveBeenCalledWith("doc-1", "Madde 3 anlaşılmıyor");
    expect(field()).toHaveValue("");
    const keys = invalidate.mock.calls.map(([filter]) => (filter as { queryKey: string[] }).queryKey);
    expect(keys).toEqual(expect.arrayContaining([["feedback"], ["dashboard-stats"], ["audit-logs"]]));
  });

  it("takes the confirmation away as soon as the user starts writing the next one", async () => {
    renderForm();
    await userEvent.type(field(), "Madde 3 anlaşılmıyor");
    await submit();
    await screen.findByRole("status");

    await userEvent.type(field(), "x");

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it.each([
    ["FEEDBACK_RATE_LIMITED", 429],
    ["FEEDBACK_NOT_ACCEPTED", 409],
    ["DOCUMENT_NOT_FOUND", 404],
  ] as const)("keeps what was written and shows the refusal %s", async (code, status) => {
    sendFeedback.mockRejectedValue(new ApiError(status, code, "refused"));
    renderForm();
    await userEvent.type(field(), "Madde 3 anlaşılmıyor");

    await submit();

    expect(await screen.findByRole("alert")).toHaveTextContent(tr.errors[code]);
    expect(field()).toHaveValue("Madde 3 anlaşılmıyor");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("says so when the server cannot be reached", async () => {
    sendFeedback.mockRejectedValue(new TypeError("failed to fetch"));
    renderForm();
    await userEvent.type(field(), "Madde 3 anlaşılmıyor");

    await submit();

    expect(await screen.findByRole("alert")).toHaveTextContent(tr.errors.NETWORK);
  });

  it("blocks a second click while sending", async () => {
    let finish: (value: unknown) => void = () => undefined;
    sendFeedback.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    renderForm();
    await userEvent.type(field(), "Madde 3 anlaşılmıyor");

    await submit();

    expect(await screen.findByRole("button", { name: t.submitting })).toBeDisabled();
    finish({ id: "fb-1", createdAt: "2025-06-01T09:30:00.000Z" });
    await waitFor(() => expect(screen.getByRole("button", { name: t.submit })).toBeEnabled());
    expect(sendFeedback).toHaveBeenCalledTimes(1);
  });

  it("limits the message to 2000 characters", () => {
    renderForm();
    expect(field()).toHaveAttribute("maxlength", "2000");
  });
});
