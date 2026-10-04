import type { DocumentDetailDto, EditorSessionDto } from "@iso-dms/shared";
import { documentDetail as detailFixture } from "@/test/fixtures";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { tr } from "@/lib/i18n/tr";
import { EditorScreen } from "./editor-screen";

const getDocument = vi.fn();
const getEditorSession = vi.fn();
const loadOnlyOfficeApi = vi.fn();
let reportEditorError: (description: string) => void = () => undefined;

vi.mock("@/lib/api/endpoints", () => ({
  getDocument: (id: string) => getDocument(id),
  getEditorSession: (id: string) => getEditorSession(id),
}));
vi.mock("@/lib/onlyoffice/load-api", () => ({ loadOnlyOfficeApi: () => loadOnlyOfficeApi() }));
vi.mock("@/components/editor/onlyoffice-editor", () => ({
  OnlyOfficeEditor: ({ config, onError }: { config: Record<string, unknown>; onError: (d: string) => void }) => {
    reportEditorError = onError;
    return <div data-testid="editor" data-token={String(config.token)} />;
  },
}));

const DOCUMENT_ID = "doc-1";
const REVISION_ID = "rev-1";

function documentDetail(overrides: Partial<DocumentDetailDto> = {}): DocumentDetailDto {
  return detailFixture({
    id: DOCUMENT_ID,
    status: "DRAFT",
    canEdit: true,
    revisionNo: null,
    openRevision: { id: REVISION_ID, revisionNo: 0, status: "DRAFT" },
    ...overrides,
  });
}

function session(overrides: Partial<EditorSessionDto> = {}): EditorSessionDto {
  return {
    mode: "edit",
    document: { id: DOCUMENT_ID, code: "PR-KK-001", title: "Doküman Kontrol Prosedürü", status: "DRAFT" },
    revision: { id: REVISION_ID, revisionNo: 0, status: "DRAFT" },
    config: { token: "signed-1" },
    ...overrides,
  };
}

function renderScreen(requestedRevisionId?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <EditorScreen documentId={DOCUMENT_ID} requestedRevisionId={requestedRevisionId} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getDocument.mockReset();
  getEditorSession.mockReset();
  loadOnlyOfficeApi.mockReset();
  getDocument.mockResolvedValue(documentDetail());
  getEditorSession.mockResolvedValue(session());
  loadOnlyOfficeApi.mockResolvedValue(undefined);
});

describe("EditorScreen", () => {
  it("shows a preparing message and then the editor with the signed configuration", async () => {
    renderScreen();
    expect(screen.getByRole("status")).toHaveTextContent(tr.editor.preparing);

    const editor = await screen.findByTestId("editor");

    expect(editor).toHaveAttribute("data-token", "signed-1");
    expect(getDocument).toHaveBeenCalledWith(DOCUMENT_ID);
    expect(getEditorSession).toHaveBeenCalledWith(REVISION_ID);
  });

  it("shows code, title, status, revision and an editing label with the autosave hint", async () => {
    renderScreen();
    await screen.findByTestId("editor");

    expect(screen.getByText("PR-KK-001")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Doküman Kontrol Prosedürü" })).toBeInTheDocument();
    expect(screen.getByText(tr.documents.status.DRAFT)).toBeInTheDocument();
    expect(screen.getByText(tr.editor.revision(0))).toBeInTheDocument();
    expect(screen.getByText(tr.editor.modeEdit)).toBeInTheDocument();
    expect(screen.getByText(tr.editor.autosaveHint)).toBeInTheDocument();
  });

  it("labels a read only session and omits the autosave hint", async () => {
    getEditorSession.mockResolvedValue(session({ mode: "view" }));
    renderScreen();
    await screen.findByTestId("editor");

    expect(screen.getByText(tr.editor.modeView)).toBeInTheDocument();
    expect(screen.queryByText(tr.editor.autosaveHint)).not.toBeInTheDocument();
  });

  it("links back to the detail page of the document", async () => {
    renderScreen();
    await screen.findByTestId("editor");

    expect(screen.getByRole("link", { name: tr.editor.back })).toHaveAttribute("href", `/documents/${DOCUMENT_ID}`);
  });

  it("opens the revision that was asked for instead of the one the API picks", async () => {
    getEditorSession.mockResolvedValue(
      session({ mode: "view", revision: { id: "rev-old", revisionNo: 0, status: "SUPERSEDED" } }),
    );
    renderScreen("rev-old");

    await screen.findByTestId("editor");

    expect(getEditorSession).toHaveBeenCalledWith("rev-old");
    expect(getEditorSession).not.toHaveBeenCalledWith(REVISION_ID);
    expect(screen.getByText(tr.editor.revision(0))).toBeInTheDocument();
    expect(screen.getByText(tr.editor.modeView)).toBeInTheDocument();
  });

  it("can open a specific revision even when the document has no revision picked for it", async () => {
    getDocument.mockResolvedValue(documentDetail({ openRevision: null, canEdit: false }));
    renderScreen("rev-old");

    expect(await screen.findByTestId("editor")).toBeInTheDocument();
    expect(getEditorSession).toHaveBeenCalledWith("rev-old");
  });

  it("does not ask for a new configuration while the user works", async () => {
    const { rerender } = renderScreen();
    await screen.findByTestId("editor");

    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <div />
      </QueryClientProvider>,
    );

    expect(getEditorSession).toHaveBeenCalledTimes(1);
  });

  describe("when something goes wrong", () => {
    it("says so when the document does not exist or is not visible", async () => {
      getDocument.mockRejectedValue(new ApiError(404, "DOCUMENT_NOT_FOUND"));
      renderScreen();

      expect(await screen.findByRole("alert")).toHaveTextContent(tr.errors.DOCUMENT_NOT_FOUND);
      expect(getEditorSession).not.toHaveBeenCalled();
      expect(screen.queryByTestId("editor")).not.toBeInTheDocument();
    });

    it("says so when there is no revision to open", async () => {
      getDocument.mockResolvedValue(documentDetail({ openRevision: null, canEdit: false }));
      renderScreen();

      expect(await screen.findByRole("alert")).toHaveTextContent(tr.editor.noRevision);
      expect(getEditorSession).not.toHaveBeenCalled();
    });

    it("translates a refusal to open the revision", async () => {
      getEditorSession.mockRejectedValue(new ApiError(404, "REVISION_NOT_FOUND"));
      renderScreen();

      expect(await screen.findByRole("alert")).toHaveTextContent(tr.errors.REVISION_NOT_FOUND);
    });

    it("retries loading the configuration", async () => {
      getEditorSession.mockRejectedValueOnce(new ApiError(500));
      renderScreen();
      await screen.findByRole("alert");

      await userEvent.click(screen.getByRole("button", { name: tr.common.retry }));

      expect(await screen.findByTestId("editor")).toBeInTheDocument();
    });

    it("explains that the editor server is unreachable and retries loading its script", async () => {
      loadOnlyOfficeApi.mockRejectedValueOnce(new Error("api.js could not be loaded"));
      renderScreen();

      expect(await screen.findByRole("alert")).toHaveTextContent(tr.editor.serverUnreachable);

      await userEvent.click(screen.getByRole("button", { name: tr.common.retry }));
      expect(await screen.findByTestId("editor")).toBeInTheDocument();
    });

    it("shows the error the editor reports and lets the user start again", async () => {
      renderScreen();
      await screen.findByTestId("editor");

      reportEditorError("Download failed");
      expect(await screen.findByRole("alert")).toHaveTextContent(`${tr.editor.editorError} (Download failed)`);

      await userEvent.click(screen.getByRole("button", { name: tr.common.retry }));
      expect(await screen.findByTestId("editor")).toBeInTheDocument();
    });

    it("shows a connection problem for failures that are not API errors", async () => {
      getDocument.mockRejectedValue(new TypeError("fetch failed"));
      renderScreen();

      expect(await screen.findByRole("alert")).toHaveTextContent(tr.errors.NETWORK);
    });
  });
});
