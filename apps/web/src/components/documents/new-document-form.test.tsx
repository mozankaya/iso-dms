import type { CategoryDto, DepartmentDto, SessionUserDto, TemplateDto } from "@iso-dms/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { tr } from "@/lib/i18n/tr";
import { NewDocumentForm } from "./new-document-form";

const t = tr.newDocument;
const push = vi.fn();
const createDocument = vi.fn();
const uploadDocument = vi.fn();
const getTemplates = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/api/endpoints", () => ({
  createDocument: (request: unknown) => createDocument(request),
  uploadDocument: (request: unknown) => uploadDocument(request),
  getTemplates: (query: unknown) => getTemplates(query),
}));

const categories: CategoryDto[] = [
  { id: "cat-pr", name: "Prosedürler", slug: "procedures", codePrefix: "PR", description: null, icon: null, sortOrder: 1, isExternal: false, externalUrl: null, documentCount: 0 },
  { id: "cat-fr", name: "Formlar", slug: "forms", codePrefix: "FR", description: null, icon: null, sortOrder: 2, isExternal: false, externalUrl: null, documentCount: 0 },
];
const departments: DepartmentDto[] = [
  { id: "dep-kk", name: "Kalite Koordinatörlüğü", code: "KK" },
  { id: "dep-ik", name: "İnsan Kaynakları", code: "IK" },
];
const templates: TemplateDto[] = [
  { id: "tpl-1", name: "Standart Prosedür", fileType: "DOCX", categoryId: null, isDefault: true },
  { id: "tpl-2", name: "Kısa Prosedür", fileType: "DOCX", categoryId: "cat-pr", isDefault: false },
];

function user(overrides: Partial<SessionUserDto> = {}): SessionUserDto {
  return {
    id: "u1",
    organizationId: "o1",
    departmentId: null,
    email: "a@b.c",
    fullName: "Test",
    role: "ADMIN",
    ...overrides,
  };
}

function renderForm(options: { user?: SessionUserDto; initialCategoryId?: string } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NewDocumentForm
        user={options.user ?? user()}
        categories={categories}
        departments={departments}
        initialCategoryId={options.initialCategoryId ?? ""}
      />
    </QueryClientProvider>,
  );
}

const submit = () => userEvent.click(screen.getByRole("button", { name: t.submit }));
const select = (label: string, value: string) => userEvent.selectOptions(screen.getByLabelText(label), value);

// File inputs restrict the picker with accept=; tests need to bypass that to try unsupported files
const uploader = () => userEvent.setup({ applyAccept: false });

beforeEach(() => {
  push.mockReset();
  createDocument.mockReset();
  uploadDocument.mockReset();
  getTemplates.mockReset();
  getTemplates.mockResolvedValue(templates);
  createDocument.mockResolvedValue({ id: "d1", code: "PR-KK-001" });
  uploadDocument.mockResolvedValue({ id: "d2", code: "PR-KK-002" });
});

describe("NewDocumentForm", () => {
  it("shows Turkish validation messages and does not call the API", async () => {
    renderForm();

    await submit();

    expect(await screen.findByText(t.validation.categoryRequired)).toBeInTheDocument();
    expect(screen.getByText(t.validation.departmentRequired)).toBeInTheDocument();
    expect(screen.getByText(t.validation.titleRequired)).toBeInTheDocument();
    expect(createDocument).not.toHaveBeenCalled();
  });

  it("rejects a title that is too short", async () => {
    renderForm({ initialCategoryId: "cat-pr" });
    await select(t.department, "dep-kk");
    await userEvent.type(screen.getByLabelText(t.documentTitle), "ab");

    await submit();

    expect(await screen.findByText(t.validation.titleTooShort)).toBeInTheDocument();
  });

  it("preselects the category it was opened from", () => {
    renderForm({ initialCategoryId: "cat-fr" });
    expect(screen.getByLabelText(t.category)).toHaveValue("cat-fr");
  });

  it("creates a document from the default template and goes to the category list", async () => {
    renderForm({ initialCategoryId: "cat-pr" });
    await select(t.department, "dep-kk");
    await userEvent.type(screen.getByLabelText(t.documentTitle), "  Doküman Kontrol Prosedürü ");

    await submit();

    await waitFor(() =>
      expect(createDocument).toHaveBeenCalledWith({
        categoryId: "cat-pr",
        departmentId: "dep-kk",
        title: "Doküman Kontrol Prosedürü",
        fileType: "DOCX",
        templateId: undefined,
      }),
    );
    expect(push).toHaveBeenCalledWith("/categories/procedures?created=PR-KK-001");
  });

  it("offers the templates of the category and sends the chosen one", async () => {
    renderForm({ initialCategoryId: "cat-pr" });
    await select(t.department, "dep-ik");
    await userEvent.type(screen.getByLabelText(t.documentTitle), "Kısa Prosedür Örneği");
    await screen.findByRole("option", { name: "Kısa Prosedür" });
    expect(getTemplates).toHaveBeenCalledWith({ categoryId: "cat-pr", fileType: "DOCX" });

    await select(t.template, "tpl-2");
    await submit();

    await waitFor(() => expect(createDocument).toHaveBeenCalled());
    expect(createDocument.mock.calls[0][0]).toMatchObject({ templateId: "tpl-2" });
  });

  it("asks for Excel templates when Excel is chosen", async () => {
    renderForm({ initialCategoryId: "cat-fr" });

    await userEvent.click(screen.getByLabelText(t.excel));

    await waitFor(() => expect(getTemplates).toHaveBeenLastCalledWith({ categoryId: "cat-fr", fileType: "XLSX" }));
  });

  it("fixes the department of an editor to their own", async () => {
    renderForm({ user: user({ role: "EDITOR", departmentId: "dep-ik" }), initialCategoryId: "cat-pr" });

    const departmentSelect = screen.getByLabelText(t.department);
    expect(departmentSelect).toBeDisabled();
    expect(departmentSelect).toHaveValue("dep-ik");
    expect(screen.getByText(t.departmentLocked)).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(t.documentTitle), "Editör Dokümanı");
    await submit();

    await waitFor(() => expect(createDocument).toHaveBeenCalled());
    expect(createDocument.mock.calls[0][0]).toMatchObject({ departmentId: "dep-ik" });
  });

  it("lets a quality manager choose any department", () => {
    renderForm({ user: user({ role: "QUALITY_MANAGER" }) });
    expect(screen.getByLabelText(t.department)).toBeEnabled();
  });

  describe("upload", () => {
    async function switchToUpload() {
      await userEvent.click(screen.getByLabelText(t.fromUpload));
    }

    it("uploads a file, fills the title from the file name and shows the detected type", async () => {
      const user = uploader();
      renderForm({ initialCategoryId: "cat-pr" });
      await select(t.department, "dep-kk");
      await switchToUpload();

      const file = new File(["x"], "Prosedür Taslağı.docx");
      await user.upload(screen.getByLabelText(t.file), file);

      expect(screen.getByLabelText(t.documentTitle)).toHaveValue("Prosedür Taslağı");
      expect(screen.getByText(t.detectedType(t.word))).toBeInTheDocument();
      expect(screen.queryByLabelText(t.template)).not.toBeInTheDocument();

      await submit();

      await waitFor(() =>
        expect(uploadDocument).toHaveBeenCalledWith({
          categoryId: "cat-pr",
          departmentId: "dep-kk",
          title: "Prosedür Taslağı",
          file,
        }),
      );
      expect(createDocument).not.toHaveBeenCalled();
      expect(push).toHaveBeenCalledWith("/categories/procedures?created=PR-KK-002");
    });

    it("keeps a title the user already typed", async () => {
      const user = uploader();
      renderForm({ initialCategoryId: "cat-pr" });
      await userEvent.type(screen.getByLabelText(t.documentTitle), "Benim Başlığım");
      await switchToUpload();

      await user.upload(screen.getByLabelText(t.file), new File(["x"], "baska-ad.xlsx"));

      expect(screen.getByLabelText(t.documentTitle)).toHaveValue("Benim Başlığım");
    });

    it("requires a file", async () => {
      renderForm({ initialCategoryId: "cat-pr" });
      await select(t.department, "dep-kk");
      await userEvent.type(screen.getByLabelText(t.documentTitle), "Dosyasız Doküman");
      await switchToUpload();

      await submit();

      expect(await screen.findByText(t.validation.fileRequired)).toBeInTheDocument();
      expect(uploadDocument).not.toHaveBeenCalled();
    });

    it.each([
      ["an unsupported file", () => new File(["x"], "notlar.pdf"), t.validation.fileTypeUnsupported],
      ["an empty file", () => new File([], "bos.docx"), t.validation.fileEmpty],
      ["a file above the limit", () => new File([new Uint8Array(26 * 1024 * 1024)], "buyuk.docx"), t.validation.fileTooLarge(25)],
    ])("blocks %s before it is sent", async (_label, makeFile, message) => {
      const user = uploader();
      renderForm({ initialCategoryId: "cat-pr" });
      await select(t.department, "dep-kk");
      await switchToUpload();

      await user.upload(screen.getByLabelText(t.file), makeFile());
      await userEvent.type(screen.getByLabelText(t.documentTitle), " Başlık");
      await submit();

      expect(await screen.findByText(message)).toBeInTheDocument();
      expect(uploadDocument).not.toHaveBeenCalled();
    });
  });

  describe("server errors", () => {
    async function fillAndSubmit() {
      renderForm({ initialCategoryId: "cat-pr" });
      await select(t.department, "dep-kk");
      await userEvent.type(screen.getByLabelText(t.documentTitle), "Hata Denemesi");
      await submit();
    }

    it("shows the Turkish message of an API error and stays on the page", async () => {
      createDocument.mockRejectedValueOnce(new ApiError(403, "DEPARTMENT_NOT_ALLOWED"));

      await fillAndSubmit();

      expect(await screen.findByRole("alert")).toHaveTextContent(tr.errors.DEPARTMENT_NOT_ALLOWED);
      expect(push).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: t.submit })).toBeEnabled();
    });

    it("explains an invalid file content error", async () => {
      createDocument.mockRejectedValueOnce(new ApiError(400, "INVALID_FILE_CONTENT"));

      await fillAndSubmit();

      expect(await screen.findByRole("alert")).toHaveTextContent(tr.errors.INVALID_FILE_CONTENT);
    });

    it("explains a connection problem", async () => {
      createDocument.mockRejectedValueOnce(new TypeError("fetch failed"));

      await fillAndSubmit();

      expect(await screen.findByRole("alert")).toHaveTextContent(tr.errors.NETWORK);
    });

    it("disables the button while the request is running", async () => {
      let finish: (value: unknown) => void = () => undefined;
      createDocument.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));

      await fillAndSubmit();

      expect(await screen.findByRole("button", { name: t.submitting })).toBeDisabled();
      finish({ id: "d1", code: "PR-KK-009" });
      await waitFor(() => expect(push).toHaveBeenCalled());
    });
  });

  it("links the cancel button back to the chosen category", () => {
    renderForm({ initialCategoryId: "cat-fr" });
    expect(screen.getByRole("link", { name: t.cancel })).toHaveAttribute("href", "/categories/forms");
  });
});
