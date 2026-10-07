import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { tr } from "@/lib/i18n/tr";
import { auditLogEntry, documentDetail, revisionRow } from "@/test/fixtures";
import { DocumentDetail } from "./document-detail";

const getDocument = vi.fn();
const getRevisions = vi.fn();
const getDocumentAuditLogs = vi.fn();
let role = "READER";

vi.mock("@/lib/api/endpoints", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/endpoints")>()),
  getDocument: (id: string) => getDocument(id),
  getRevisions: (id: string) => getRevisions(id),
  getDocumentAuditLogs: (id: string, query: unknown) => getDocumentAuditLogs(id, query),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/auth/auth-context", () => ({
  useAuth: () => ({ status: "authenticated", user: { id: "u1", role }, login: vi.fn(), logout: vi.fn() }),
}));
vi.mock("@/components/documents/download-button", () => ({
  DownloadButton: ({ path }: { path: string }) => (
    <button type="button" data-path={path}>
      {tr.detail.download}
    </button>
  ),
}));

const t = tr.detail;

/** The download button of the document itself (the revision history has its own, one per row). */
function documentDownload(): HTMLElement | undefined {
  return screen.queryAllByRole("button", { name: t.download }).find((button) => button.dataset.path === "/documents/doc-1/download");
}

function renderDetail() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DocumentDetail documentId="doc-1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getDocument.mockReset();
  getRevisions.mockReset();
  getDocumentAuditLogs.mockReset();
  role = "READER";
  getDocument.mockResolvedValue(documentDetail());
  getRevisions.mockResolvedValue([revisionRow()]);
});

describe("DocumentDetail", () => {
  it("shows a loading message first", () => {
    renderDetail();
    expect(screen.getByRole("status")).toHaveTextContent(tr.common.loading);
  });

  it("shows code, title and status in the heading", async () => {
    renderDetail();

    const heading = await screen.findByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent("Doküman Kontrol Prosedürü");
    expect(within(heading).getByText(tr.documents.status.PUBLISHED)).toBeInTheDocument();
    expect(screen.getAllByText("PR-KK-001").length).toBeGreaterThan(0);
  });

  it("lists the document information", async () => {
    renderDetail();
    await screen.findByRole("heading", { level: 1 });
    const info = screen.getByText(t.info).closest("div")!;

    const value = (label: string) => within(info).getByText(label).nextElementSibling?.textContent;
    expect(value(t.category)).toBe("Prosedürler");
    expect(value(t.department)).toBe("Kalite Koordinatörlüğü");
    expect(value(t.owner)).toBe("Ece Editör");
    expect(value(t.fileType)).toBe(t.word);
    expect(value(t.currentRevision)).toBe("2");
    expect(value(t.firstPublishedAt)).toBe("10.01.2025");
    expect(value(t.revisedAt)).toBe("01.06.2025");
    expect(value(t.createdAt)).toBe("01.12.2024");
    expect(value(t.reviewInterval)).toBe(t.reviewIntervalMonths(12));
    expect(value(t.nextReviewAt)).toBe("01.06.2026");
    expect(value(t.retention)).toBe(t.retentionYears(5));
  });

  it("links to the category", async () => {
    renderDetail();
    await screen.findByRole("heading", { level: 1 });

    expect(screen.getAllByRole("link", { name: /Prosedürler/ })[0]).toHaveAttribute("href", "/categories/procedures");
  });

  it("uses dashes and a notice for a document that was never published", async () => {
    getDocument.mockResolvedValue(
      documentDetail({
        status: "DRAFT",
        revisionNo: null,
        currentRevisionId: null,
        firstPublishedAt: null,
        revisedAt: null,
        nextReviewAt: null,
        reviewIntervalMonths: null,
        retentionYears: null,
      }),
    );
    renderDetail();
    await screen.findByRole("heading", { level: 1 });
    const info = screen.getByText(t.info).closest("div")!;

    expect(within(info).getByText(t.currentRevision).nextElementSibling).toHaveTextContent(t.noCurrentRevision);
    expect(within(info).getByText(t.reviewInterval).nextElementSibling).toHaveTextContent(t.notSet);
    expect(within(info).getByText(t.retention).nextElementSibling).toHaveTextContent(t.notSet);
    expect(within(info).getByText(t.firstPublishedAt).nextElementSibling).toHaveTextContent("-");
  });

  describe("actions", () => {
    it("offers editing when the user may edit, and a download when a revision is in force", async () => {
      getDocument.mockResolvedValue(documentDetail({ canEdit: true }));
      renderDetail();
      await screen.findByRole("heading", { level: 1 });

      const edit = screen.getByRole("link", { name: t.edit });
      expect(edit).toHaveAttribute("href", "/documents/doc-1/edit");
      expect(documentDownload()).toBeDefined();
    });

    it("offers publishing the open draft to those who may", async () => {
      getDocument.mockResolvedValue(
        documentDetail({
          status: "DRAFT",
          canEdit: true,
          canPublish: true,
          currentRevisionId: null,
          openRevision: { id: "rev-9", revisionNo: 0, status: "DRAFT", changeSummary: null },
        }),
      );
      renderDetail();
      await screen.findByRole("heading", { level: 1 });

      expect(screen.getByRole("button", { name: tr.publish.button })).toBeInTheDocument();
    });

    it("offers starting a revision to those who may, on a document in force", async () => {
      getDocument.mockResolvedValue(documentDetail({ canStartRevision: true }));
      renderDetail();
      await screen.findByRole("heading", { level: 1 });

      expect(screen.getByRole("button", { name: tr.startRevision.button })).toBeInTheDocument();
    });

    it("hides the start button from everybody else, and while a revision is open", async () => {
      renderDetail();
      await screen.findByRole("heading", { level: 1 });

      expect(screen.queryByRole("button", { name: tr.startRevision.button })).not.toBeInTheDocument();
    });

    it("hides the publish button from everybody else", async () => {
      renderDetail();
      await screen.findByRole("heading", { level: 1 });

      expect(screen.queryByRole("button", { name: tr.publish.button })).not.toBeInTheDocument();
    });

    it("offers viewing otherwise", async () => {
      renderDetail();
      await screen.findByRole("heading", { level: 1 });

      expect(screen.getByRole("link", { name: t.view })).toHaveAttribute("href", "/documents/doc-1/edit");
      expect(screen.queryByRole("link", { name: t.edit })).not.toBeInTheDocument();
    });

    it("offers no document download while nothing is in force", async () => {
      getDocument.mockResolvedValue(documentDetail({ status: "DRAFT", currentRevisionId: null, revisionNo: null }));
      renderDetail();
      await screen.findByRole("heading", { level: 1 });

      expect(documentDownload()).toBeUndefined();
    });

    it("offers no way to open the document when the user may open no revision", async () => {
      getDocument.mockResolvedValue(documentDetail({ openRevision: null }));
      renderDetail();
      await screen.findByRole("heading", { level: 1 });

      expect(screen.queryByRole("link", { name: t.view })).not.toBeInTheDocument();
    });
  });

  describe("withdrawn documents", () => {
    it("warns that the document is invalid and shows why it was withdrawn", async () => {
      getDocument.mockResolvedValue(
        documentDetail({ status: "WITHDRAWN", withdrawnAt: "2026-03-01T09:00:00.000Z", withdrawalReason: "Artık kullanılmıyor" }),
      );
      renderDetail();
      await screen.findByRole("heading", { level: 1 });

      expect(screen.getByRole("status")).toHaveTextContent(t.withdrawnNotice);
      const info = screen.getByText(t.info).closest("div")!;
      expect(within(info).getByText(t.withdrawnAt).nextElementSibling).toHaveTextContent("01.03.2026");
      expect(within(info).getByText(t.withdrawalReason).nextElementSibling).toHaveTextContent("Artık kullanılmıyor");
    });

    it("does not claim a revision is in force", async () => {
      getDocument.mockResolvedValue(documentDetail({ status: "WITHDRAWN", withdrawnAt: "2026-03-01T09:00:00.000Z" }));
      getRevisions.mockResolvedValue([revisionRow({ isCurrent: false })]);
      renderDetail();
      await screen.findByRole("heading", { level: 1 });
      const info = screen.getByText(t.info).closest("div")!;

      expect(within(info).getByText(t.currentRevision).nextElementSibling).toHaveTextContent(t.noRevisionInForce);
      const table = await screen.findByRole("table", { name: tr.revisions.tableLabel });
      expect(within(table).getByText(tr.revisions.status.SUPERSEDED)).toBeInTheDocument();
    });

    it("does not mention withdrawal for other documents", async () => {
      renderDetail();
      await screen.findByRole("heading", { level: 1 });

      expect(screen.queryByText(t.withdrawnNotice)).not.toBeInTheDocument();
      expect(screen.queryByText(t.withdrawnAt)).not.toBeInTheDocument();
    });
  });

  describe("revision history", () => {
    it("shows the revisions of the document", async () => {
      getRevisions.mockResolvedValue([
        revisionRow({ id: "rev-3", revisionNo: 3, status: "DRAFT", isCurrent: false, canEdit: true, changeSummary: "Taslak" }),
        revisionRow(),
      ]);
      renderDetail();

      const table = await screen.findByRole("table", { name: tr.revisions.tableLabel });
      expect(within(table).getByText("Taslak", { selector: "td" })).toBeInTheDocument();
      expect(within(table).getByText(tr.revisions.status.CURRENT)).toBeInTheDocument();
      expect(getRevisions).toHaveBeenCalledWith("doc-1");
    });

    it("shows its own error without hiding the document, and can retry", async () => {
      getRevisions.mockRejectedValueOnce(new ApiError(500));
      renderDetail();

      expect(await screen.findByText(tr.revisions.loadError)).toBeInTheDocument();
      expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: tr.common.retry }));
      expect(await screen.findByRole("table", { name: tr.revisions.tableLabel })).toBeInTheDocument();
    });
  });

  describe("errors", () => {
    it("says so when the document does not exist or is not visible", async () => {
      getDocument.mockRejectedValue(new ApiError(404, "DOCUMENT_NOT_FOUND"));
      renderDetail();

      expect(await screen.findByRole("alert")).toHaveTextContent(t.notFound);
      expect(screen.getByRole("link", { name: tr.category.backToHome })).toHaveAttribute("href", "/");
      expect(screen.queryByText(tr.revisions.title)).not.toBeInTheDocument();
    });

    it("offers a retry for other failures", async () => {
      getDocument.mockRejectedValueOnce(new ApiError(500));
      renderDetail();

      expect(await screen.findByRole("alert")).toHaveTextContent(t.loadError);

      await userEvent.click(screen.getByRole("button", { name: tr.common.retry }));
      expect(await screen.findByRole("heading", { level: 1 })).toBeInTheDocument();
    });
  });
});

describe("DocumentDetail audit history", () => {
  const history = () => screen.queryByRole("heading", { name: tr.audit.documentTitle });

  it.each(["READER", "EDITOR", "APPROVER"])("is not offered to %s", async (who) => {
    role = who;
    renderDetail();
    await screen.findByRole("heading", { level: 1 });

    expect(history()).not.toBeInTheDocument();
    expect(getDocumentAuditLogs).not.toHaveBeenCalled();
  });

  it.each(["QUALITY_MANAGER", "ADMIN"])("is offered to %s, closed at first", async (who) => {
    role = who;
    renderDetail();
    await screen.findByRole("heading", { level: 1 });

    expect(history()).toBeInTheDocument();
    expect(getDocumentAuditLogs).not.toHaveBeenCalled();
  });

  it("shows the history of this document once it is opened", async () => {
    role = "QUALITY_MANAGER";
    getDocumentAuditLogs.mockResolvedValue({ items: [auditLogEntry()], total: 1, page: 1, pageSize: 20 });
    renderDetail();
    await screen.findByRole("heading", { level: 1 });

    await userEvent.click(screen.getByRole("button", { name: tr.audit.show }));

    expect(await screen.findByRole("table", { name: tr.audit.tableLabel })).toBeInTheDocument();
    expect(getDocumentAuditLogs).toHaveBeenCalledWith("doc-1", { page: 1, pageSize: 20 });
  });
});
