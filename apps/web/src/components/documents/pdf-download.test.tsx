import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PdfStatus } from "@iso-dms/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { tr } from "@/lib/i18n/tr";
import { PdfDownload } from "./pdf-download";

const t = tr.pdf;
const requestRevisionPdf = vi.fn();

vi.mock("@/components/documents/download-button", () => ({
  DownloadButton: ({ path, label }: { path: string; label?: string }) => (
    <button type="button" data-path={path}>
      {label}
    </button>
  ),
}));
vi.mock("@/lib/api/endpoints", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/endpoints")>()),
  requestRevisionPdf: (id: string) => requestRevisionPdf(id),
}));

function renderPdf(status: PdfStatus, canRequest = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  render(
    <QueryClientProvider client={client}>
      <PdfDownload status={status} path="/revisions/r1/download?format=pdf" fallbackName="PR-KK-001" revisionId="r1" documentId="d1" canRequest={canRequest} />
    </QueryClientProvider>,
  );
  return { invalidate };
}

beforeEach(() => {
  requestRevisionPdf.mockReset();
});

describe("PdfDownload", () => {
  it.each([false, true])("offers the PDF once it exists (can request: %s)", (canRequest) => {
    renderPdf("READY", canRequest);
    expect(screen.getByRole("button", { name: t.download })).toHaveAttribute("data-path", "/revisions/r1/download?format=pdf");
    expect(screen.queryByRole("button", { name: t.request })).not.toBeInTheDocument();
  });

  it.each([false, true])("says the copy is being made, for everybody (can request: %s)", (canRequest) => {
    renderPdf("PENDING", canRequest);
    expect(screen.getByRole("status")).toHaveTextContent(t.pending);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it.each(["FAILED", "NONE"] as const)("shows nothing to those who do not look after the copies when it is %s", (status) => {
    const { invalidate } = renderPdf(status, false);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByText(t.failed)).not.toBeInTheDocument();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("tells the quality management that the copy failed, or is missing, and lets them ask again", async () => {
    requestRevisionPdf.mockResolvedValue({ id: "r1", pdfStatus: "PENDING" });
    const { invalidate } = renderPdf("FAILED", true);
    expect(screen.getByText(t.failed)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: t.request }));

    await waitFor(() => expect(requestRevisionPdf).toHaveBeenCalledWith("r1"));
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["revisions", "d1"] }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["document", "d1"] });
  });

  it("says a revision from before copies existed has none", () => {
    renderPdf("NONE", true);
    expect(screen.getByText(t.missing)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t.request })).toBeInTheDocument();
  });

  it("shows the reason the API gives in Turkish", async () => {
    requestRevisionPdf.mockRejectedValue(new ApiError(409, "PDF_ALREADY_EXISTS"));
    renderPdf("FAILED", true);

    await userEvent.click(screen.getByRole("button", { name: t.request }));

    expect(await screen.findByRole("alert")).toHaveTextContent(tr.errors.PDF_ALREADY_EXISTS);
  });
});
