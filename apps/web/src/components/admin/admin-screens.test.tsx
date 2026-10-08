import type { AdminCategoryDto, AdminDepartmentDto } from "@iso-dms/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { tr } from "@/lib/i18n/tr";
import { CategoryAdmin } from "./category-admin";
import { DepartmentAdmin } from "./department-admin";

let role = "ADMIN";
const getAdminDepartments = vi.fn();
const createDepartment = vi.fn();
const updateDepartment = vi.fn();
const getAdminCategories = vi.fn();
const createCategory = vi.fn();
const updateCategory = vi.fn();

vi.mock("@/lib/auth/auth-context", () => ({
  useAuth: () => ({ status: "authenticated", user: { id: "u1", role }, login: vi.fn(), logout: vi.fn() }),
}));
vi.mock("@/lib/api/endpoints", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/endpoints")>()),
  getAdminDepartments: () => getAdminDepartments(),
  createDepartment: (request: unknown) => createDepartment(request),
  updateDepartment: (id: string, request: unknown) => updateDepartment(id, request),
  getAdminCategories: () => getAdminCategories(),
  createCategory: (request: unknown) => createCategory(request),
  updateCategory: (id: string, request: unknown) => updateCategory(id, request),
}));

function department(overrides: Partial<AdminDepartmentDto> = {}): AdminDepartmentDto {
  return { id: "d1", name: "Kalite Koordinatörlüğü", code: "KK", isActive: true, userCount: 4, documentCount: 12, createdAt: "2025-03-01T09:00:00.000Z", ...overrides };
}

function category(overrides: Partial<AdminCategoryDto> = {}): AdminCategoryDto {
  return {
    id: "c1",
    name: "Prosedürler",
    slug: "prosedurler",
    codePrefix: "PR",
    description: null,
    icon: null,
    sortOrder: 1,
    isExternal: false,
    externalUrl: null,
    isActive: true,
    documentCount: 7,
    createdAt: "2025-03-01T09:00:00.000Z",
    ...overrides,
  };
}

function renderWith(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
  return { invalidate };
}

const invalidatedKeys = (invalidate: { mock: { calls: unknown[][] } }) => invalidate.mock.calls.map((call) => (call[0] as { queryKey: string[] }).queryKey[0]);

beforeEach(() => {
  vi.clearAllMocks();
  role = "ADMIN";
});

describe("DepartmentAdmin", () => {
  const t = tr.admin.departments;

  it("lists the departments with what depends on them", async () => {
    getAdminDepartments.mockResolvedValue([department(), department({ id: "d2", name: "Eski Birim", code: "EB", isActive: false, userCount: 0, documentCount: 0 })]);
    renderWith(<DepartmentAdmin />);

    const table = await screen.findByRole("table", { name: t.tableLabel });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("KK")).toBeInTheDocument();
    expect(within(rows[0]).getByText("12")).toBeInTheDocument();
    expect(within(rows[0]).getByText(tr.admin.common.active)).toBeInTheDocument();
    expect(within(rows[1]).getByText(tr.admin.common.inactive)).toBeInTheDocument();
    expect(screen.getByText(t.total(2))).toBeInTheDocument();
  });

  it("shows nothing but a notice to anyone who is not the administrator, and asks for nothing", () => {
    role = "QUALITY_MANAGER";
    renderWith(<DepartmentAdmin />);

    expect(screen.getByText(tr.admin.common.forbidden)).toBeInTheDocument();
    expect(getAdminDepartments).not.toHaveBeenCalled();
  });

  it("tells when the list cannot be loaded", async () => {
    getAdminDepartments.mockRejectedValue(new ApiError(500, "UNKNOWN", "x"));
    renderWith(<DepartmentAdmin />);

    expect(await screen.findByRole("alert")).toHaveTextContent(tr.admin.common.loadError);
  });

  it("adds a department with the code in capitals, then refreshes every list that shows departments", async () => {
    getAdminDepartments.mockResolvedValue([]);
    createDepartment.mockResolvedValue(department());
    const user = userEvent.setup();
    const { invalidate } = renderWith(<DepartmentAdmin />);

    await user.click(await screen.findByRole("button", { name: t.add }));
    await user.type(screen.getByLabelText(tr.admin.common.name), "  Kalite Koordinatörlüğü ");
    await user.type(screen.getByLabelText(t.code), "kk");
    await user.click(screen.getByRole("button", { name: tr.admin.common.save }));

    await waitFor(() => expect(createDepartment).toHaveBeenCalledWith({ name: "Kalite Koordinatörlüğü", code: "KK" }));
    await waitFor(() => expect(invalidatedKeys(invalidate)).toEqual(expect.arrayContaining(["admin-departments", "departments", "audit-logs"])));
  });

  it("does not send a form with a short name or a bad code, and says why", async () => {
    getAdminDepartments.mockResolvedValue([]);
    const user = userEvent.setup();
    renderWith(<DepartmentAdmin />);

    await user.click(await screen.findByRole("button", { name: t.add }));
    await user.type(screen.getByLabelText(tr.admin.common.name), "A");
    await user.type(screen.getByLabelText(t.code), "K-K");
    await user.click(screen.getByRole("button", { name: tr.admin.common.save }));

    expect(screen.getByText(t.validation.nameLength)).toBeInTheDocument();
    expect(screen.getByText(t.validation.codeFormat)).toBeInTheDocument();
    expect(createDepartment).not.toHaveBeenCalled();
  });

  it("shows the reason the API gives in Turkish and keeps the form open", async () => {
    getAdminDepartments.mockResolvedValue([]);
    createDepartment.mockRejectedValue(new ApiError(409, "DEPARTMENT_CODE_TAKEN", "x"));
    const user = userEvent.setup();
    renderWith(<DepartmentAdmin />);

    await user.click(await screen.findByRole("button", { name: t.add }));
    await user.type(screen.getByLabelText(tr.admin.common.name), "Kalite");
    await user.type(screen.getByLabelText(t.code), "KK");
    await user.click(screen.getByRole("button", { name: tr.admin.common.save }));

    expect(await screen.findByRole("alert")).toHaveTextContent(tr.errors.DEPARTMENT_CODE_TAKEN);
    expect(screen.getByLabelText(tr.admin.common.name)).toBeInTheDocument();
  });

  it("renames a department, showing its code locked", async () => {
    getAdminDepartments.mockResolvedValue([department()]);
    updateDepartment.mockResolvedValue(department({ name: "Yeni Ad" }));
    const user = userEvent.setup();
    renderWith(<DepartmentAdmin />);

    await user.click(await screen.findByRole("button", { name: `${tr.admin.common.edit}: Kalite Koordinatörlüğü` }));
    expect(screen.getByLabelText(t.code)).toBeDisabled();
    const name = screen.getByLabelText(tr.admin.common.name);
    await user.clear(name);
    await user.type(name, "Yeni Ad");
    await user.click(screen.getByRole("button", { name: tr.admin.common.save }));

    await waitFor(() => expect(updateDepartment).toHaveBeenCalledWith("d1", { name: "Yeni Ad" }));
  });

  it("asks before taking a department out of use, and says nothing is lost", async () => {
    getAdminDepartments.mockResolvedValue([department()]);
    updateDepartment.mockResolvedValue(department({ isActive: false }));
    const user = userEvent.setup();
    renderWith(<DepartmentAdmin />);

    await user.click(await screen.findByRole("button", { name: `${tr.admin.common.deactivate}: Kalite Koordinatörlüğü` }));
    expect(screen.getByText(t.deactivateConfirm("Kalite Koordinatörlüğü"))).toBeInTheDocument();
    expect(updateDepartment).not.toHaveBeenCalled();

    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: tr.admin.common.deactivate }));

    await waitFor(() => expect(updateDepartment).toHaveBeenCalledWith("d1", { isActive: false }));
  });

  it("puts a department back in use", async () => {
    getAdminDepartments.mockResolvedValue([department({ isActive: false })]);
    updateDepartment.mockResolvedValue(department());
    const user = userEvent.setup();
    renderWith(<DepartmentAdmin />);

    await user.click(await screen.findByRole("button", { name: `${tr.admin.common.activate}: Kalite Koordinatörlüğü` }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: tr.admin.common.activate }));

    await waitFor(() => expect(updateDepartment).toHaveBeenCalledWith("d1", { isActive: true }));
  });
});

describe("CategoryAdmin", () => {
  const t = tr.admin.categories;

  it("lists the categories with prefix, place and the documents they hold", async () => {
    getAdminCategories.mockResolvedValue([category(), category({ id: "c2", name: "Dış Kaynaklı", codePrefix: "DK", isExternal: true, isActive: false, documentCount: 0, sortOrder: 15 })]);
    renderWith(<CategoryAdmin />);

    const table = await screen.findByRole("table", { name: t.tableLabel });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(within(rows[0]).getByText("PR")).toBeInTheDocument();
    expect(within(rows[0]).getByText("7")).toBeInTheDocument();
    expect(within(rows[1]).getByText(tr.admin.common.inactive)).toBeInTheDocument();
    expect(within(rows[1]).getByText(/dış kaynaklı kategori/)).toBeInTheDocument();
  });

  it("shows nothing but a notice to anyone who is not the administrator", () => {
    role = "EDITOR";
    renderWith(<CategoryAdmin />);

    expect(screen.getByText(tr.admin.common.forbidden)).toBeInTheDocument();
    expect(getAdminCategories).not.toHaveBeenCalled();
  });

  it("adds a category, leaving out what was not filled in, and refreshes the menu", async () => {
    getAdminCategories.mockResolvedValue([]);
    createCategory.mockResolvedValue(category());
    const user = userEvent.setup();
    const { invalidate } = renderWith(<CategoryAdmin />);

    await user.click(await screen.findByRole("button", { name: t.add }));
    await user.type(screen.getByLabelText(tr.admin.common.name), "Prosedürler");
    await user.type(screen.getByLabelText(t.prefix), "pr");
    await user.click(screen.getByRole("button", { name: tr.admin.common.save }));

    await waitFor(() =>
      expect(createCategory).toHaveBeenCalledWith({ name: "Prosedürler", codePrefix: "PR", description: null, icon: null, isExternal: false, externalUrl: undefined }),
    );
    await waitFor(() => expect(invalidatedKeys(invalidate)).toEqual(expect.arrayContaining(["admin-categories", "categories", "audit-logs"])));
  });

  it("sends the link only for an external category", async () => {
    getAdminCategories.mockResolvedValue([]);
    createCategory.mockResolvedValue(category());
    const user = userEvent.setup();
    renderWith(<CategoryAdmin />);

    await user.click(await screen.findByRole("button", { name: t.add }));
    expect(screen.queryByLabelText(t.externalUrl)).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(tr.admin.common.name), "Dış Kaynaklı Dokümanlar");
    await user.type(screen.getByLabelText(t.prefix), "DK");
    await user.click(screen.getByLabelText(t.isExternal));
    await user.type(screen.getByLabelText(t.externalUrl), "https://mevzuat.example.org");
    await user.type(screen.getByLabelText(t.sortOrder), "15");
    await user.click(screen.getByRole("button", { name: tr.admin.common.save }));

    await waitFor(() =>
      expect(createCategory).toHaveBeenCalledWith(
        expect.objectContaining({ codePrefix: "DK", isExternal: true, externalUrl: "https://mevzuat.example.org", sortOrder: 15 }),
      ),
    );
  });

  it("does not send a form with a bad prefix, link or place, and says why", async () => {
    getAdminCategories.mockResolvedValue([]);
    const user = userEvent.setup();
    renderWith(<CategoryAdmin />);

    await user.click(await screen.findByRole("button", { name: t.add }));
    await user.type(screen.getByLabelText(tr.admin.common.name), "A");
    await user.type(screen.getByLabelText(t.prefix), "P1");
    await user.type(screen.getByLabelText(t.sortOrder), "-4");
    await user.click(screen.getByLabelText(t.isExternal));
    await user.type(screen.getByLabelText(t.externalUrl), "mevzuat");
    await user.click(screen.getByRole("button", { name: tr.admin.common.save }));

    for (const message of [t.validation.nameLength, t.validation.prefixFormat, t.validation.urlFormat, t.validation.sortOrderRange]) {
      expect(screen.getByText(message)).toBeInTheDocument();
    }
    expect(createCategory).not.toHaveBeenCalled();
  });

  it("shows the reason the API gives in Turkish", async () => {
    getAdminCategories.mockResolvedValue([]);
    createCategory.mockRejectedValue(new ApiError(409, "CATEGORY_PREFIX_TAKEN", "x"));
    const user = userEvent.setup();
    renderWith(<CategoryAdmin />);

    await user.click(await screen.findByRole("button", { name: t.add }));
    await user.type(screen.getByLabelText(tr.admin.common.name), "Prosedürler");
    await user.type(screen.getByLabelText(t.prefix), "PR");
    await user.click(screen.getByRole("button", { name: tr.admin.common.save }));

    expect(await screen.findByRole("alert")).toHaveTextContent(tr.errors.CATEGORY_PREFIX_TAKEN);
  });

  it("edits a category with prefix and external flag locked, and clears an emptied description", async () => {
    getAdminCategories.mockResolvedValue([category({ description: "Eski", isExternal: true, externalUrl: "https://example.org" })]);
    updateCategory.mockResolvedValue(category());
    const user = userEvent.setup();
    renderWith(<CategoryAdmin />);

    await user.click(await screen.findByRole("button", { name: `${tr.admin.common.edit}: Prosedürler` }));
    expect(screen.getByLabelText(t.prefix)).toBeDisabled();
    expect(screen.getByLabelText(t.isExternal)).toBeDisabled();
    await user.clear(screen.getByLabelText(t.descriptionLabel));
    await user.click(screen.getByRole("button", { name: tr.admin.common.save }));

    await waitFor(() =>
      expect(updateCategory).toHaveBeenCalledWith("c1", { name: "Prosedürler", description: null, icon: null, externalUrl: "https://example.org", sortOrder: 1 }),
    );
  });

  it("asks before taking a category out of use, naming the documents that stay", async () => {
    getAdminCategories.mockResolvedValue([category()]);
    updateCategory.mockResolvedValue(category({ isActive: false }));
    const user = userEvent.setup();
    renderWith(<CategoryAdmin />);

    await user.click(await screen.findByRole("button", { name: `${tr.admin.common.deactivate}: Prosedürler` }));
    expect(screen.getByText(t.deactivateConfirm("Prosedürler", 7))).toBeInTheDocument();
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: tr.admin.common.deactivate }));

    await waitFor(() => expect(updateCategory).toHaveBeenCalledWith("c1", { isActive: false }));
  });
});
