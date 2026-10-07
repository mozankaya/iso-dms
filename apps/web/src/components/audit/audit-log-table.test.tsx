import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { tr } from "@/lib/i18n/tr";
import { auditLogEntry } from "@/test/fixtures";
import { AuditLogTable } from "./audit-log-table";

const t = tr.audit;

const opened = auditLogEntry();
const downloaded = auditLogEntry({
  id: "audit-2",
  action: "REVISION_DOWNLOADED",
  entityType: "Revision",
  entityId: "rev-2",
  createdAt: "2025-06-02T21:30:00.000Z",
  user: { id: "user-2", fullName: "Onur Onaylayıcı", email: "onur@example.com" },
  document: { id: "doc-1", code: "PR-KK-001", title: "Doküman Kontrol Prosedürü", revisionNo: 2 },
  metadata: { fileSize: 24576 },
  ipAddress: "203.0.113.7",
});
const failedLogin = auditLogEntry({
  id: "audit-3",
  action: "USER_LOGIN_FAILED",
  entityType: "User",
  entityId: "unknown",
  user: null,
  document: null,
  metadata: { reason: "UNKNOWN_USER", email: "kimse@example.com" },
});

function renderTable(props: { showDocument?: boolean; showAddress?: boolean } = {}) {
  return render(<AuditLogTable items={[opened, downloaded, failedLogin]} showDocument={props.showDocument ?? true} showAddress={props.showAddress ?? false} />);
}

/** The desktop table; the mobile list shows the same entries and is checked separately. */
const table = () => screen.getByRole("table", { name: t.tableLabel });

describe("AuditLogTable", () => {
  it("shows when, who, what and how for every entry", () => {
    renderTable();
    const rows = within(table()).getAllByRole("row").slice(1);

    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText("01.06.2025 12:30")).toBeInTheDocument();
    expect(within(rows[0]).getByText("Ece Editör")).toBeInTheDocument();
    expect(within(rows[0]).getByText("ece@example.com")).toBeInTheDocument();
    expect(within(rows[0]).getByText(t.actions.DOCUMENT_OPENED)).toBeInTheDocument();
    expect(within(rows[0]).getByText(tr.audit.details.modeEdit)).toBeInTheDocument();

    expect(within(rows[1]).getByText("03.06.2025 00:30")).toBeInTheDocument(); // Istanbul time, next day
    expect(within(rows[1]).getByText(t.actions.REVISION_DOWNLOADED)).toBeInTheDocument();
    expect(within(rows[1]).getByText("24 KB")).toBeInTheDocument();
  });

  it("links the document and names the revision an entry is about", () => {
    renderTable();
    const rows = within(table()).getAllByRole("row").slice(1);

    const opening = within(rows[0]).getByRole("link", { name: "PR-KK-001" });
    expect(opening).toHaveAttribute("href", "/documents/doc-1");
    const download = within(rows[1]).getByRole("link", { name: /PR-KK-001/ });
    expect(download).toHaveTextContent(t.revision(2));
  });

  it("copes with entries nobody caused and entries about no document", () => {
    renderTable();
    const row = within(table()).getAllByRole("row")[3];

    expect(within(row).getByText(t.noUser)).toBeInTheDocument();
    expect(within(row).queryByRole("link")).not.toBeInTheDocument();
    expect(within(row).getByText(/kimse@example.com/)).toBeInTheDocument();
  });

  it("leaves the document column out on the history of one document", () => {
    renderTable({ showDocument: false });

    expect(within(table()).queryByRole("columnheader", { name: t.columns.document })).not.toBeInTheDocument();
    expect(within(table()).queryByRole("link")).not.toBeInTheDocument();
  });

  it("shows the address column only when asked to", () => {
    const { unmount } = renderTable({ showAddress: true });
    expect(within(table()).getByRole("columnheader", { name: t.columns.ipAddress })).toBeInTheDocument();
    expect(within(table()).getByText("203.0.113.7")).toBeInTheDocument();
    unmount();

    renderTable({ showAddress: false });
    expect(screen.queryByText(t.columns.ipAddress)).not.toBeInTheDocument();
    expect(screen.queryByText("203.0.113.7")).not.toBeInTheDocument();
  });

  it("offers the same entries as cards on small screens", () => {
    renderTable({ showAddress: true });
    const cards = within(screen.getByRole("list", { name: t.tableLabel })).getAllByRole("listitem");

    expect(cards).toHaveLength(3);
    expect(within(cards[1]).getByText(t.actions.REVISION_DOWNLOADED)).toBeInTheDocument();
    expect(within(cards[1]).getByText("203.0.113.7")).toBeInTheDocument();
  });
});
