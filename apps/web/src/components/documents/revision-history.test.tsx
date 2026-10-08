import type { DocumentStatus } from "@iso-dms/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { tr } from "@/lib/i18n/tr";
import { revisionRow } from "@/test/fixtures";
import { RevisionHistory } from "./revision-history";

vi.mock("@/components/documents/download-button", () => ({
  DownloadButton: ({ path, ariaLabel }: { path: string; ariaLabel?: string }) => (
    <button type="button" data-path={path} aria-label={ariaLabel}>
      indir
    </button>
  ),
}));

const t = tr.revisions;

const current = revisionRow();
const draft = revisionRow({
  id: "rev-3",
  revisionNo: 3,
  status: "DRAFT",
  isCurrent: false,
  approvedBy: null,
  approvedAt: null,
  publishedAt: null,
  changeSummary: null,
  canEdit: true,
  preparedBy: { id: "user-3", fullName: "Berk Editör" },
});
const old = revisionRow({
  id: "rev-1",
  revisionNo: 1,
  status: "SUPERSEDED",
  isCurrent: false,
  publishedAt: "2024-12-31T21:30:00.000Z",
  changeSummary: "İlk sürüm düzeltmesi",
});

function renderHistory(revisions = [draft, current, old], documentStatus: DocumentStatus = "PUBLISHED", canRequestPdf = false) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <RevisionHistory documentId="doc-1" code="PR-KK-001" documentStatus={documentStatus} revisions={revisions} canRequestPdf={canRequestPdf} />
    </QueryClientProvider>,
  );
}

describe("RevisionHistory", () => {
  it("says so when there is nothing to show", () => {
    renderHistory([]);
    expect(screen.getByText(t.empty)).toBeInTheDocument();
  });

  describe("table", () => {
    const rowOf = (revisionNo: number) =>
      within(screen.getByRole("table", { name: t.tableLabel }))
        .getAllByRole("row")
        .find((row) => within(row).queryAllByRole("cell")[0]?.textContent === String(revisionNo))!;

    it("lists the revisions in the order given, with the documented columns", () => {
      renderHistory();
      const table = screen.getByRole("table", { name: t.tableLabel });

      for (const column of Object.values(t.columns)) {
        expect(within(table).getByRole("columnheader", { name: column })).toBeInTheDocument();
      }
      const numbers = within(table)
        .getAllByRole("row")
        .slice(1)
        .map((row) => within(row).getAllByRole("cell")[0].textContent);
      expect(numbers).toEqual(["3", "2", "1"]);
    });

    it("shows who prepared and approved a revision and what changed", () => {
      renderHistory();

      const row = rowOf(2);
      expect(within(row).getByText("Ece Editör")).toBeInTheDocument();
      expect(within(row).getByText("Onur Onaylayıcı")).toBeInTheDocument();
      expect(within(row).getByText("Madde 3 güncellendi")).toBeInTheDocument();
    });

    it("uses a dash for what a draft does not have yet", () => {
      renderHistory();

      expect(within(rowOf(3)).getAllByText(tr.detail.notSet)).toHaveLength(2); // approver and change summary
    });

    it("dates a revision by when it went into force, in Istanbul time", () => {
      renderHistory();

      expect(within(rowOf(2)).getByText("01.06.2025")).toBeInTheDocument();
      // 21:30 UTC is already the next day in Istanbul
      expect(within(rowOf(1)).getByText("01.01.2025")).toBeInTheDocument();
    });

    it("falls back to the approval date and then to the creation date", () => {
      renderHistory([
        revisionRow({ id: "a", revisionNo: 4, publishedAt: null, approvedAt: "2025-03-05T09:00:00.000Z" }),
        revisionRow({ id: "b", revisionNo: 5, publishedAt: null, approvedAt: null, createdAt: "2025-04-06T09:00:00.000Z" }),
      ]);

      expect(within(rowOf(4)).getByText("05.03.2025")).toBeInTheDocument();
      expect(within(rowOf(5)).getByText("06.04.2025")).toBeInTheDocument();
    });

    it("badges the revision in force, the replaced ones and drafts differently", () => {
      renderHistory();

      expect(within(rowOf(2)).getByText(t.status.CURRENT)).toBeInTheDocument();
      expect(within(rowOf(1)).getByText(t.status.SUPERSEDED)).toBeInTheDocument();
      expect(within(rowOf(3)).getByText(t.status.DRAFT)).toBeInTheDocument();
    });

    it("shows the approved revisions of a withdrawn document as invalid, not as in force", () => {
      renderHistory([revisionRow({ isCurrent: false })], "WITHDRAWN");

      const row = within(screen.getByRole("table", { name: t.tableLabel })).getAllByRole("row")[1];
      expect(within(row).getByText(t.status.SUPERSEDED)).toBeInTheDocument();
      expect(within(row).queryByText(t.status.CURRENT)).not.toBeInTheDocument();
    });

    it("opens each revision itself: editable ones for editing, the others for viewing", () => {
      renderHistory();

      expect(within(rowOf(3)).getAllByRole("link")[0]).toHaveTextContent(tr.detail.edit);
      expect(within(rowOf(3)).getAllByRole("link")[0]).toHaveAttribute("href", "/documents/doc-1/edit?revision=rev-3");
      expect(within(rowOf(2)).getAllByRole("link")[0]).toHaveTextContent(tr.detail.view);
      expect(within(rowOf(1)).getAllByRole("link")[0]).toHaveAttribute("href", "/documents/doc-1/edit?revision=rev-1");
    });

    it("downloads the file of that very revision", () => {
      renderHistory();

      expect(within(rowOf(1)).getByRole("button", { name: `${tr.detail.download} (${t.revision(1)})` })).toHaveAttribute("data-path", "/revisions/rev-1/download");
      expect(within(rowOf(3)).getByRole("button", { name: `${tr.detail.download} (${t.revision(3)})` })).toBeInTheDocument();
    });

    it("offers the PDF of each revision that was put in force, and none for a draft", () => {
      renderHistory();

      expect(within(rowOf(1)).getByRole("button", { name: `${tr.pdf.download} (${t.revision(1)})` })).toHaveAttribute("data-path", "/revisions/rev-1/download?format=pdf");
      expect(within(rowOf(2)).getByRole("button", { name: `${tr.pdf.download} (${t.revision(2)})` })).toHaveAttribute("data-path", "/revisions/rev-2/download?format=pdf");
      expect(within(rowOf(3)).queryByRole("button", { name: new RegExp(`^${tr.pdf.download} `) })).not.toBeInTheDocument();
    });

    it("says a copy is being made, and hides a failed one from those who cannot ask again", () => {
      const waiting = revisionRow({ id: "rev-2", pdfStatus: "PENDING" });
      const failed = revisionRow({ id: "rev-1", revisionNo: 1, status: "SUPERSEDED", isCurrent: false, pdfStatus: "FAILED" });
      renderHistory([waiting, failed]);

      expect(within(rowOf(2)).getByText(tr.pdf.pending)).toBeInTheDocument();
      expect(within(rowOf(1)).queryByText(tr.pdf.failed)).not.toBeInTheDocument();
    });

    it("lets the quality management ask for a failed copy again", () => {
      const failed = revisionRow({ id: "rev-1", revisionNo: 1, status: "SUPERSEDED", isCurrent: false, pdfStatus: "FAILED" });
      renderHistory([failed], "PUBLISHED", true);

      expect(within(rowOf(1)).getByText(tr.pdf.failed)).toBeInTheDocument();
      expect(within(rowOf(1)).getByRole("button", { name: tr.pdf.request })).toBeInTheDocument();
    });
  });

  describe("cards (mobile)", () => {
    it("shows the same information per revision", () => {
      renderHistory();
      const list = screen.getByRole("list", { name: t.tableLabel });
      const cards = within(list).getAllByRole("listitem");

      expect(cards).toHaveLength(3);
      expect(within(cards[1]).getByText(t.revision(2))).toBeInTheDocument();
      expect(within(cards[1]).getByText(t.status.CURRENT)).toBeInTheDocument();
      expect(within(cards[1]).getByText("Onur Onaylayıcı")).toBeInTheDocument();
      expect(within(cards[1]).getByText("Madde 3 güncellendi")).toBeInTheDocument();
      expect(within(cards[0]).getAllByRole("link")[0]).toHaveAttribute("href", "/documents/doc-1/edit?revision=rev-3");
    });
  });

  it("links each revision to a comparison with the one before it, the oldest has none", () => {
    renderHistory();

    const table = screen.getByRole("table", { name: t.tableLabel });
    const links = within(table).getAllByRole("link", { name: new RegExp(t.compareWithPrevious) });
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/documents/doc-1/compare?from=rev-2&to=rev-3",
      "/documents/doc-1/compare?from=rev-1&to=rev-2",
    ]);
  });

  it("offers no comparison for a single revision", () => {
    renderHistory([current]);
    expect(screen.queryAllByRole("link", { name: new RegExp(t.compareWithPrevious) })).toHaveLength(0);
  });
});
