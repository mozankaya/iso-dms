import type { RevisionComparisonDto } from "@iso-dms/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { tr } from "@/lib/i18n/tr";
import { revisionRow } from "@/test/fixtures";
import { chooseRevisions, RevisionCompare } from "./revision-compare";

const t = tr.compare;

const replace = vi.fn();
let currentSearch = "";
const getRevisions = vi.fn();
const getRevisionComparison = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => "/documents/doc-1/compare",
  useSearchParams: () => new URLSearchParams(currentSearch),
}));
vi.mock("@/lib/api/endpoints", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/endpoints")>()),
  getRevisions: () => getRevisions(),
  getRevisionComparison: (...args: unknown[]) => getRevisionComparison(...args),
}));

const rev3 = revisionRow({ id: "rev-3", revisionNo: 3, status: "DRAFT", isCurrent: false });
const rev2 = revisionRow({ id: "rev-2", revisionNo: 2 });
const rev1 = revisionRow({ id: "rev-1", revisionNo: 1, status: "SUPERSEDED", isCurrent: false });

const wordComparison: RevisionComparisonDto = {
  fileType: "DOCX",
  from: { id: "rev-1", revisionNo: 1, status: "SUPERSEDED" },
  to: { id: "rev-2", revisionNo: 2, status: "APPROVED" },
  summary: { added: 1, removed: 1, changed: 1 },
  cells: [],
  blocks: [
    { kind: "equal", segments: [{ type: "equal", text: "1. Amaç" }] },
    {
      kind: "changed",
      segments: [
        { type: "equal", text: "Kayıtlar " },
        { type: "removed", text: "beş" },
        { type: "added", text: "on" },
        { type: "equal", text: " yıl saklanır." },
      ],
    },
    { kind: "removed", segments: [{ type: "removed", text: "Eski madde" }] },
    { kind: "added", segments: [{ type: "added", text: "Yeni madde" }] },
  ],
};

const sheetComparison: RevisionComparisonDto = {
  fileType: "XLSX",
  from: wordComparison.from,
  to: wordComparison.to,
  summary: { added: 1, removed: 0, changed: 1 },
  blocks: [],
  cells: [
    { kind: "changed", sheet: "Sayfa1", address: "B1", from: "10", to: "12" },
    { kind: "added", sheet: "Sayfa1", address: "A3", from: null, to: "Kahve" },
  ],
};

function renderCompare() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RevisionCompare documentId="doc-1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  currentSearch = "";
  getRevisions.mockResolvedValue([rev3, rev2, rev1]);
  getRevisionComparison.mockResolvedValue(wordComparison);
});

describe("chooseRevisions", () => {
  const list = [rev3, rev2, rev1];

  it("needs two revisions", () => {
    expect(chooseRevisions([rev2], null, null)).toBeNull();
  });

  it("takes the newest revision and the one before it by default", () => {
    expect(chooseRevisions(list, null, null)).toEqual({ from: "rev-2", to: "rev-3" });
  });

  it("takes the revision before the chosen new one when only that is given", () => {
    expect(chooseRevisions(list, null, "rev-2")).toEqual({ from: "rev-1", to: "rev-2" });
  });

  it("falls back to another revision when the new one is the oldest", () => {
    expect(chooseRevisions(list, null, "rev-1")).toEqual({ from: "rev-3", to: "rev-1" });
  });

  it("keeps a valid choice and replaces unknown or equal ones", () => {
    expect(chooseRevisions(list, "rev-1", "rev-3")).toEqual({ from: "rev-1", to: "rev-3" });
    expect(chooseRevisions(list, "nope", "also-nope")).toEqual({ from: "rev-2", to: "rev-3" });
    expect(chooseRevisions(list, "rev-3", "rev-3")).toEqual({ from: "rev-2", to: "rev-3" });
  });
});

describe("RevisionCompare", () => {
  it("compares the two newest revisions by default and says what changed", async () => {
    renderCompare();

    expect(await screen.findByText(t.summary(1, 1, 1))).toBeInTheDocument();
    expect(getRevisionComparison).toHaveBeenCalledWith("doc-1", "rev-2", "rev-3");
    expect(screen.getByLabelText(t.from)).toHaveValue("rev-2");
    expect(screen.getByLabelText(t.to)).toHaveValue("rev-3");
  });

  it("marks removed text and added text apart from the text that stayed", async () => {
    renderCompare();
    await screen.findByText(t.summary(1, 1, 1));

    const result = screen.getByRole("region", { name: t.resultLabel });
    expect(within(result).getByText("beş").tagName).toBe("DEL");
    expect(within(result).getByText("on").tagName).toBe("INS");
    expect(within(result).getByText("Eski madde").tagName).toBe("DEL");
    expect(within(result).getByText("Yeni madde").tagName).toBe("INS");
    expect(within(result).getByText("1. Amaç").closest("li")).toHaveAttribute("data-kind", "equal");
  });

  it("can hide the paragraphs that did not change", async () => {
    renderCompare();
    await screen.findByText(t.summary(1, 1, 1));

    await userEvent.click(screen.getByRole("checkbox", { name: t.onlyChanges }));

    expect(screen.queryByText("1. Amaç")).not.toBeInTheDocument();
    expect(screen.getByText("Yeni madde")).toBeInTheDocument();
  });

  it("puts a new choice in the address", async () => {
    renderCompare();
    await screen.findByText(t.summary(1, 1, 1));

    await userEvent.selectOptions(screen.getByLabelText(t.from), "rev-1");

    expect(replace).toHaveBeenCalledWith("/documents/doc-1/compare?from=rev-1&to=rev-3", { scroll: false });
  });

  it("does not offer the other side's revision on either list", async () => {
    renderCompare();
    await screen.findByText(t.summary(1, 1, 1));

    const fromOptions = within(screen.getByLabelText(t.from)).getAllByRole("option") as HTMLOptionElement[];
    expect(fromOptions.find((option) => option.value === "rev-3")?.disabled).toBe(true);
    expect(fromOptions.find((option) => option.value === "rev-1")?.disabled).toBe(false);
  });

  it("uses the revisions in the address", async () => {
    currentSearch = "from=rev-1&to=rev-2";
    renderCompare();

    await screen.findByText(t.summary(1, 1, 1));
    expect(getRevisionComparison).toHaveBeenCalledWith("doc-1", "rev-1", "rev-2");
  });

  it("lists the cells that differ for an Excel file", async () => {
    getRevisionComparison.mockResolvedValue(sheetComparison);
    renderCompare();

    const table = await screen.findByRole("table", { name: t.cellsLabel });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("B1")).toBeInTheDocument();
    expect(within(rows[0]).getByText("10").tagName).toBe("DEL");
    expect(within(rows[0]).getByText("12").tagName).toBe("INS");
    expect(within(rows[1]).getByText("Kahve")).toBeInTheDocument();
    expect(within(rows[1]).getByText(t.empty)).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: t.onlyChanges })).not.toBeInTheDocument();
  });

  it("says so when the texts are the same", async () => {
    getRevisionComparison.mockResolvedValue({ ...sheetComparison, summary: { added: 0, removed: 0, changed: 0 }, cells: [] });
    renderCompare();

    expect(await screen.findByText(t.noChanges)).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: t.cellsLabel })).not.toBeInTheDocument();
  });

  it("asks for a second revision when there is only one", async () => {
    getRevisions.mockResolvedValue([rev2]);
    renderCompare();

    expect(await screen.findByText(t.needTwo)).toBeInTheDocument();
    expect(getRevisionComparison).not.toHaveBeenCalled();
  });

  it("shows why a comparison failed in Turkish", async () => {
    getRevisionComparison.mockRejectedValue(new ApiError(422, "DOCUMENT_TOO_LARGE_TO_COMPARE"));
    renderCompare();

    expect(await screen.findByRole("alert")).toHaveTextContent(tr.errors.DOCUMENT_TOO_LARGE_TO_COMPARE);
  });

  it("lets the user retry when the revisions cannot be loaded", async () => {
    getRevisions.mockRejectedValueOnce(new ApiError(500, undefined)).mockResolvedValue([rev3, rev2, rev1]);
    renderCompare();

    await userEvent.click(await screen.findByRole("button", { name: tr.common.retry }));

    expect(await screen.findByText(t.summary(1, 1, 1))).toBeInTheDocument();
  });
});
