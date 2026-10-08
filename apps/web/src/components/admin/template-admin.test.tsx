import type { AdminTemplateDto } from "@iso-dms/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { tr } from "@/lib/i18n/tr";
import { TemplateAdmin } from "./template-admin";

const t = tr.admin.templates;
const common = tr.admin.common;

let role = "ADMIN";
const getAdminTemplates = vi.fn();
const getCategories = vi.fn();
const createTemplate = vi.fn();
const updateTemplate = vi.fn();
const replaceTemplateFile = vi.fn();
const deleteTemplate = vi.fn();
const downloadFromApi = vi.fn();

vi.mock("@/lib/auth/auth-context", () => ({
  useAuth: () => ({ status: "authenticated", user: { id: "u1", role }, login: vi.fn(), logout: vi.fn() }),
}));
vi.mock("@/lib/download", () => ({ downloadFromApi: (path: string, name: string) => downloadFromApi(path, name) }));
vi.mock("@/lib/api/endpoints", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/endpoints")>()),
  getAdminTemplates: () => getAdminTemplates(),
  getCategories: () => getCategories(),
  createTemplate: (request: unknown) => createTemplate(request),
  updateTemplate: (id: string, request: unknown) => updateTemplate(id, request),
  replaceTemplateFile: (id: string, file: File) => replaceTemplateFile(id, file),
  deleteTemplate: (id: string) => deleteTemplate(id),
}));

function template(overrides: Partial<AdminTemplateDto> = {}): AdminTemplateDto {
  return { id: "t1", name: "Prosedür Şablonu", fileType: "DOCX", category: { id: "c1", name: "Prosedürler" }, isDefault: true, createdAt: "2026-10-01T09:00:00.000Z", ...overrides };
}

const docx = (name = "yeni.docx", size = 100) => new File([new Uint8Array(size)], name);

function renderAdmin() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  render(
    <QueryClientProvider client={client}>
      <TemplateAdmin />
    </QueryClientProvider>,
  );
  return { invalidate };
}

const invalidatedKeys = (invalidate: { mock: { calls: unknown[][] } }) => invalidate.mock.calls.map((call) => (call[0] as { queryKey: string[] }).queryKey[0]);

beforeEach(() => {
  vi.clearAllMocks();
  role = "ADMIN";
  getAdminTemplates.mockResolvedValue([template(), template({ id: "t2", name: "Genel Excel", fileType: "XLSX", category: null, isDefault: false })]);
  getCategories.mockResolvedValue([{ id: "c1", name: "Prosedürler", slug: "prosedurler" }]);
});

describe("TemplateAdmin list", () => {
  it("lists the templates with type, category and the default", async () => {
    renderAdmin();

    const table = await screen.findByRole("table", { name: t.tableLabel });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText(t.fileTypes.DOCX)).toBeInTheDocument();
    expect(within(rows[0]).getByText("Prosedürler")).toBeInTheDocument();
    expect(within(rows[0]).getByText(t.defaultBadge)).toBeInTheDocument();
    expect(within(rows[1]).getByText(t.allCategories)).toBeInTheDocument();
    expect(within(rows[1]).queryByText(t.defaultBadge)).not.toBeInTheDocument();
  });

  it("shows nothing but a notice to anyone who is not the administrator, and asks for nothing", () => {
    role = "QUALITY_MANAGER";
    renderAdmin();

    expect(screen.getByText(common.forbidden)).toBeInTheDocument();
    expect(getAdminTemplates).not.toHaveBeenCalled();
  });

  it("tells when the list cannot be loaded", async () => {
    getAdminTemplates.mockRejectedValue(new ApiError(500, "UNKNOWN"));
    renderAdmin();
    expect(await screen.findByRole("alert")).toHaveTextContent(common.loadError);
  });
});

describe("TemplateAdmin adding", () => {
  async function openCreate() {
    const user = userEvent.setup({ applyAccept: false });
    await user.click(await screen.findByRole("button", { name: t.add }));
    return user;
  }

  it("adds a template: the file name suggests the name, and everything is sent as chosen", async () => {
    createTemplate.mockResolvedValue(template());
    const { invalidate } = renderAdmin();
    const user = await openCreate();

    const file = docx("Çalışma Talimatı.docx");
    await user.upload(screen.getByLabelText(t.file), file);
    expect(screen.getByLabelText(t.name)).toHaveValue("Çalışma Talimatı");
    await user.selectOptions(screen.getByLabelText(t.category), "c1");
    await user.click(screen.getByLabelText(t.setDefault));
    await user.click(screen.getByRole("button", { name: common.save }));

    await waitFor(() => expect(createTemplate).toHaveBeenCalledWith({ name: "Çalışma Talimatı", categoryId: "c1", isDefault: true, file }));
    await waitFor(() => expect(invalidatedKeys(invalidate)).toEqual(expect.arrayContaining(["admin-templates", "templates", "audit-logs"])));
  });

  it("sends none for a template of every category", async () => {
    createTemplate.mockResolvedValue(template());
    renderAdmin();
    const user = await openCreate();

    await user.upload(screen.getByLabelText(t.file), docx());
    await user.click(screen.getByRole("button", { name: common.save }));

    await waitFor(() => expect(createTemplate).toHaveBeenCalledWith(expect.objectContaining({ categoryId: null, isDefault: false })));
  });

  it.each([
    ["no file", null, fileMessagesOf().fileRequired],
    ["a file of a type nobody accepts", () => docx("a.pdf"), fileMessagesOf().fileTypeUnsupported],
    ["an empty file", () => docx("a.docx", 0), fileMessagesOf().fileEmpty],
    ["a file over the limit", () => docx("a.docx", 26 * 1024 * 1024), fileMessagesOf().fileTooLarge(25)],
  ])("does not send %s", async (_label, makeFile, message) => {
    renderAdmin();
    const user = await openCreate();

    await user.type(screen.getByLabelText(t.name), "Şablon Adı");
    if (makeFile) await user.upload(screen.getByLabelText(t.file), makeFile());
    await user.click(screen.getByRole("button", { name: common.save }));

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(createTemplate).not.toHaveBeenCalled();
  });

  it("does not send a name that is too short", async () => {
    renderAdmin();
    const user = await openCreate();

    await user.upload(screen.getByLabelText(t.file), docx());
    await user.clear(screen.getByLabelText(t.name));
    await user.type(screen.getByLabelText(t.name), "A");
    await user.click(screen.getByRole("button", { name: common.save }));

    expect(screen.getByText(t.validation.nameLength)).toBeInTheDocument();
    expect(createTemplate).not.toHaveBeenCalled();
  });

  it("shows the reason the API gives in Turkish and keeps the form open", async () => {
    createTemplate.mockRejectedValue(new ApiError(409, "TEMPLATE_NAME_TAKEN"));
    renderAdmin();
    const user = await openCreate();

    await user.upload(screen.getByLabelText(t.file), docx("Aynı.docx"));
    await user.click(screen.getByRole("button", { name: common.save }));

    expect(await screen.findByRole("alert")).toHaveTextContent(tr.errors.TEMPLATE_NAME_TAKEN);
    expect(screen.getByLabelText(t.name)).toBeInTheDocument();
  });
});

function fileMessagesOf() {
  return tr.newDocument.validation;
}

describe("TemplateAdmin changing", () => {
  it("edits name, category and default without asking for a file", async () => {
    updateTemplate.mockResolvedValue(template());
    renderAdmin();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: `${common.edit}: Prosedür Şablonu` }));
    expect(screen.queryByLabelText(t.file)).not.toBeInTheDocument();
    const name = screen.getByLabelText(t.name);
    await user.clear(name);
    await user.type(name, "Yeni Ad");
    await user.selectOptions(screen.getByLabelText(t.category), "");
    await user.click(screen.getByRole("button", { name: common.save }));

    await waitFor(() => expect(updateTemplate).toHaveBeenCalledWith("t1", { name: "Yeni Ad", categoryId: null, isDefault: true }));
  });

  it("replaces the file, and refuses one of the other type before asking the server", async () => {
    replaceTemplateFile.mockResolvedValue(template());
    renderAdmin();
    const user = userEvent.setup({ applyAccept: false });

    await user.click(await screen.findByRole("button", { name: `${t.replaceFile}: Prosedür Şablonu` }));
    expect(screen.getByText(t.replaceIntro("Prosedür Şablonu", t.fileTypes.DOCX))).toBeInTheDocument();
    const input = within(screen.getByRole("dialog")).getByLabelText(t.file);
    await user.upload(input, docx("a.xlsx"));
    await user.click(screen.getByRole("button", { name: common.save }));
    expect(replaceTemplateFile).not.toHaveBeenCalled();

    const good = docx("yeni.docx");
    await user.upload(input, good);
    await user.click(screen.getByRole("button", { name: common.save }));
    await waitFor(() => expect(replaceTemplateFile).toHaveBeenCalledWith("t1", good));
  });

  it("downloads the file under the name of the template", async () => {
    downloadFromApi.mockResolvedValue(undefined);
    renderAdmin();

    await userEvent.click(await screen.findByRole("button", { name: `${t.download}: Prosedür Şablonu` }));

    await waitFor(() => expect(downloadFromApi).toHaveBeenCalledWith("/templates/t1/download", "Prosedür Şablonu.docx"));
  });

  it("tells when the download fails", async () => {
    downloadFromApi.mockRejectedValue(new ApiError(404, "TEMPLATE_FILE_MISSING"));
    renderAdmin();

    await userEvent.click(await screen.findByRole("button", { name: `${t.download}: Prosedür Şablonu` }));

    expect(await screen.findByRole("alert")).toHaveTextContent(tr.errors.TEMPLATE_FILE_MISSING);
  });
});

describe("TemplateAdmin deleting", () => {
  it("asks before deleting, and says what stays", async () => {
    deleteTemplate.mockResolvedValue(true);
    const { invalidate } = renderAdmin();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: `${t.delete}: Prosedür Şablonu` }));
    expect(screen.getByText(t.deleteConfirm("Prosedür Şablonu"))).toBeInTheDocument();
    expect(deleteTemplate).not.toHaveBeenCalled();
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: t.delete }));

    await waitFor(() => expect(deleteTemplate).toHaveBeenCalledWith("t1"));
    await waitFor(() => expect(invalidatedKeys(invalidate)).toEqual(expect.arrayContaining(["admin-templates", "templates"])));
  });

  it("shows the reason the API gives for the last template of a type", async () => {
    deleteTemplate.mockRejectedValue(new ApiError(409, "LAST_TEMPLATE_PROTECTED"));
    renderAdmin();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: `${t.delete}: Prosedür Şablonu` }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: t.delete }));

    expect(await screen.findByRole("alert")).toHaveTextContent(tr.errors.LAST_TEMPLATE_PROTECTED);
  });
});
