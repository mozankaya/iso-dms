import type { AuditLogPage } from "@iso-dms/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tr } from "@/lib/i18n/tr";
import { auditLogEntry } from "@/test/fixtures";
import { DocumentHistory } from "./document-history";

const t = tr.audit;
const getDocumentAuditLogs = vi.fn();

vi.mock("@/lib/api/endpoints", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/endpoints")>()),
  getDocumentAuditLogs: (id: string, query: unknown) => getDocumentAuditLogs(id, query),
}));

const onePage: AuditLogPage = { items: [auditLogEntry({ ipAddress: "203.0.113.7" })], total: 1, page: 1, pageSize: 20 };

function renderHistory(showAddress = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DocumentHistory documentId="doc-1" showAddress={showAddress} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getDocumentAuditLogs.mockReset();
  getDocumentAuditLogs.mockResolvedValue(onePage);
});

describe("DocumentHistory", () => {
  it("stays closed, and does not ask the API, until somebody opens it", () => {
    renderHistory();

    expect(screen.getByRole("heading", { name: t.documentTitle })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t.show })).toHaveAttribute("aria-expanded", "false");
    expect(getDocumentAuditLogs).not.toHaveBeenCalled();
  });

  it("loads the history of the document when opened, and can be closed again", async () => {
    renderHistory();

    await userEvent.click(screen.getByRole("button", { name: t.show }));

    expect(await screen.findByRole("table", { name: t.tableLabel })).toBeInTheDocument();
    expect(getDocumentAuditLogs).toHaveBeenCalledWith("doc-1", { page: 1, pageSize: 20 });
    expect(screen.queryByRole("columnheader", { name: t.columns.document })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: t.hide }));
    expect(screen.queryByRole("table", { name: t.tableLabel })).not.toBeInTheDocument();
  });

  it("shows addresses only when told to", async () => {
    const { unmount } = renderHistory(true);
    await userEvent.click(screen.getByRole("button", { name: t.show }));
    expect((await screen.findAllByText("203.0.113.7")).length).toBeGreaterThan(0);
    unmount();

    renderHistory(false);
    await userEvent.click(screen.getByRole("button", { name: t.show }));
    await screen.findByRole("table", { name: t.tableLabel });
    expect(screen.queryByText("203.0.113.7")).not.toBeInTheDocument();
  });

  it("pages through a long history", async () => {
    getDocumentAuditLogs.mockResolvedValue({ items: [auditLogEntry()], total: 45, page: 1, pageSize: 20 });
    renderHistory();
    await userEvent.click(screen.getByRole("button", { name: t.show }));
    await screen.findByRole("table", { name: t.tableLabel });

    await userEvent.click(screen.getByRole("button", { name: tr.documents.nextPage }));

    expect(getDocumentAuditLogs).toHaveBeenLastCalledWith("doc-1", { page: 2, pageSize: 20 });
  });

  it("says so when a document has no history yet", async () => {
    getDocumentAuditLogs.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
    renderHistory();

    await userEvent.click(screen.getByRole("button", { name: t.show }));

    expect(await screen.findByText(t.empty)).toBeInTheDocument();
  });

  it("reports a failure and lets the user retry", async () => {
    getDocumentAuditLogs.mockRejectedValueOnce(new Error("boom"));
    renderHistory();
    await userEvent.click(screen.getByRole("button", { name: t.show }));

    expect(await screen.findByRole("alert")).toHaveTextContent(t.loadError);
    await userEvent.click(screen.getByRole("button", { name: tr.common.retry }));

    expect(await screen.findByRole("table", { name: t.tableLabel })).toBeInTheDocument();
  });
});
