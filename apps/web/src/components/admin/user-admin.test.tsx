import type { AdminUserDto, PaginatedDto } from "@iso-dms/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { tr } from "@/lib/i18n/tr";
import { UserAdmin } from "./user-admin";

const t = tr.admin.users;
const common = tr.admin.common;
const DEPARTMENT_ID = "3f2b8c1e-9a4d-4e6b-8c7f-1a2b3c4d5e6f";

const replace = vi.fn();
let currentSearch = "";
let role = "ADMIN";
const getAdminUsers = vi.fn();
const getDepartments = vi.fn();
const createUser = vi.fn();
const updateUser = vi.fn();
const resetUserPassword = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => "/admin/users",
  useSearchParams: () => new URLSearchParams(currentSearch),
}));
vi.mock("@/lib/auth/auth-context", () => ({
  useAuth: () => ({ status: "authenticated", user: { id: "me", role }, login: vi.fn(), logout: vi.fn() }),
}));
vi.mock("@/lib/api/endpoints", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/endpoints")>()),
  getAdminUsers: (query: unknown) => getAdminUsers(query),
  getDepartments: () => getDepartments(),
  createUser: (request: unknown) => createUser(request),
  updateUser: (id: string, request: unknown) => updateUser(id, request),
  resetUserPassword: (id: string, request: unknown) => resetUserPassword(id, request),
}));

function user(overrides: Partial<AdminUserDto> = {}): AdminUserDto {
  return {
    id: "u1",
    fullName: "Ayşe Yılmaz",
    email: "ayse@example.com",
    role: "EDITOR",
    department: { id: DEPARTMENT_ID, name: "Kalite Koordinatörlüğü", code: "KK" },
    isActive: true,
    mustChangePassword: false,
    lastLoginAt: "2026-10-01T09:00:00.000Z",
    createdAt: "2026-09-01T09:00:00.000Z",
    ...overrides,
  };
}

function page(items: AdminUserDto[], total = items.length): PaginatedDto<AdminUserDto> {
  return { items, total, page: 1, pageSize: 20 };
}

function renderAdmin() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  render(
    <QueryClientProvider client={client}>
      <UserAdmin />
    </QueryClientProvider>,
  );
  return { invalidate };
}

const invalidatedKeys = (invalidate: { mock: { calls: unknown[][] } }) => invalidate.mock.calls.map((call) => (call[0] as { queryKey: string[] }).queryKey[0]);

beforeEach(() => {
  vi.clearAllMocks();
  currentSearch = "";
  role = "ADMIN";
  getAdminUsers.mockResolvedValue(page([user(), user({ id: "me", fullName: "Ben Yönetici", email: "ben@example.com", role: "ADMIN", department: null })]));
  getDepartments.mockResolvedValue([{ id: DEPARTMENT_ID, name: "Kalite Koordinatörlüğü", code: "KK" }]);
});

describe("UserAdmin list", () => {
  it("lists the users with role, department and last sign-in", async () => {
    renderAdmin();

    const table = await screen.findByRole("table", { name: t.tableLabel });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("Ayşe Yılmaz")).toBeInTheDocument();
    expect(within(rows[0]).getByText(t.roles.EDITOR)).toBeInTheDocument();
    expect(within(rows[0]).getByText("Kalite Koordinatörlüğü")).toBeInTheDocument();
    expect(within(rows[1]).getByText(t.noDepartment)).toBeInTheDocument();
    expect(screen.getByText(t.total(2))).toBeInTheDocument();
  });

  it("marks users who still have a temporary password, never signed in, or are out of use", async () => {
    getAdminUsers.mockResolvedValue(page([user({ mustChangePassword: true, lastLoginAt: null, isActive: false })]));
    renderAdmin();

    const table = await screen.findByRole("table", { name: t.tableLabel });
    expect(within(table).getByText(t.mustChange)).toBeInTheDocument();
    expect(within(table).getByText(t.neverSignedIn)).toBeInTheDocument();
    expect(within(table).getByText(common.inactive)).toBeInTheDocument();
  });

  it("offers no reset or deactivation for the own account", async () => {
    renderAdmin();
    await screen.findByRole("table", { name: t.tableLabel });

    expect(screen.queryByRole("button", { name: `${t.resetPassword}: Ben Yönetici` })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: `${common.deactivate}: Ben Yönetici` })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: `${common.edit}: Ben Yönetici` })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `${t.resetPassword}: Ayşe Yılmaz` })).toBeInTheDocument();
  });

  it("asks for the page the URL names, with its filters", async () => {
    currentSearch = `q=ayse&role=EDITOR&department=${DEPARTMENT_ID}&status=active&page=2`;
    getAdminUsers.mockResolvedValue(page([user()], 45));
    renderAdmin();

    await screen.findByRole("table", { name: t.tableLabel });
    expect(getAdminUsers).toHaveBeenCalledWith({ search: "ayse", role: "EDITOR", departmentId: DEPARTMENT_ID, status: "active", page: 2, pageSize: 20 });
  });

  it("puts a chosen filter into the URL and goes back to the first page", async () => {
    currentSearch = "page=3";
    getAdminUsers.mockResolvedValue(page([user()], 60));
    renderAdmin();
    await screen.findByRole("table", { name: t.tableLabel });

    await userEvent.selectOptions(screen.getByLabelText(t.roleFilter), "READER");

    expect(replace).toHaveBeenCalledWith("/admin/users?role=READER", { scroll: false });
  });

  it("says so when nothing matches", async () => {
    currentSearch = "q=nobody";
    getAdminUsers.mockResolvedValue(page([]));
    renderAdmin();

    expect(await screen.findByText(t.emptyFiltered)).toBeInTheDocument();
  });

  it("shows nothing but a notice to anyone who is not the administrator, and asks for nothing", () => {
    role = "QUALITY_MANAGER";
    renderAdmin();

    expect(screen.getByText(common.forbidden)).toBeInTheDocument();
    expect(getAdminUsers).not.toHaveBeenCalled();
  });

  it("tells when the list cannot be loaded", async () => {
    getAdminUsers.mockRejectedValue(new ApiError(500, "UNKNOWN"));
    renderAdmin();

    expect(await screen.findByRole("alert")).toHaveTextContent(common.loadError);
  });
});

describe("UserAdmin forms", () => {
  async function openCreate() {
    const user_ = userEvent.setup();
    await user_.click(await screen.findByRole("button", { name: t.add }));
    return user_;
  }

  it("adds a user and shows the generated password once, with a way to copy it", async () => {
    createUser.mockResolvedValue({ user: user({ id: "new", fullName: "Yeni Kişi" }), temporaryPassword: "AbCdEfGh23456789" });
    const { invalidate } = renderAdmin();
    const user_ = await openCreate();

    await user_.type(screen.getByLabelText(t.fullName), "  Yeni Kişi ");
    await user_.type(screen.getByLabelText(t.email), "yeni@example.com");
    await user_.click(screen.getByRole("button", { name: common.save }));

    await waitFor(() => expect(createUser).toHaveBeenCalledWith({ fullName: "Yeni Kişi", email: "yeni@example.com", role: "READER", departmentId: null }));
    expect(await screen.findByText("AbCdEfGh23456789")).toBeInTheDocument();
    expect(screen.getByText(t.passwordShown.intro("Yeni Kişi"))).toBeInTheDocument();
    expect(invalidatedKeys(invalidate)).toEqual(expect.arrayContaining(["admin-users", "admin-departments", "audit-logs"]));

    await user_.click(screen.getByRole("button", { name: t.passwordShown.close }));
    expect(screen.queryByText("AbCdEfGh23456789")).not.toBeInTheDocument();
  });

  it("sends a password the administrator chose, and does not show one back", async () => {
    createUser.mockResolvedValue({ user: user({ id: "new" }), temporaryPassword: null });
    renderAdmin();
    const user_ = await openCreate();

    await user_.type(screen.getByLabelText(t.fullName), "Yeni Kişi");
    await user_.type(screen.getByLabelText(t.email), "yeni@example.com");
    await user_.type(screen.getByLabelText(t.password), "Chosen-Pass-77");
    await user_.click(screen.getByRole("button", { name: common.save }));

    await waitFor(() => expect(createUser).toHaveBeenCalledWith(expect.objectContaining({ password: "Chosen-Pass-77" })));
    expect(await screen.findByText(t.passwordShown.chosen("Yeni Kişi"))).toBeInTheDocument();
    expect(screen.queryByText("Chosen-Pass-77")).not.toBeInTheDocument();
  });

  it("does not send a form with a short name, a bad email, no department for an editor or a short password", async () => {
    renderAdmin();
    const user_ = await openCreate();

    await user_.type(screen.getByLabelText(t.fullName), "A");
    await user_.type(screen.getByLabelText(t.email), "not-an-email");
    await user_.selectOptions(within(screen.getByRole("dialog")).getByLabelText(t.role), "EDITOR");
    await user_.type(screen.getByLabelText(t.password), "short");
    await user_.click(screen.getByRole("button", { name: common.save }));

    for (const message of [t.validation.nameLength, t.validation.emailInvalid, t.validation.departmentRequired, t.validation.passwordLength]) {
      expect(screen.getByText(message)).toBeInTheDocument();
    }
    expect(createUser).not.toHaveBeenCalled();
  });

  it("sends the department of an editor", async () => {
    createUser.mockResolvedValue({ user: user(), temporaryPassword: "AbCdEfGh23456789" });
    renderAdmin();
    const user_ = await openCreate();

    await user_.type(screen.getByLabelText(t.fullName), "Yeni Editör");
    await user_.type(screen.getByLabelText(t.email), "editor@example.com");
    await user_.selectOptions(within(screen.getByRole("dialog")).getByLabelText(t.role), "EDITOR");
    await user_.selectOptions(within(screen.getByRole("dialog")).getByLabelText(t.department), DEPARTMENT_ID);
    await user_.click(screen.getByRole("button", { name: common.save }));

    await waitFor(() => expect(createUser).toHaveBeenCalledWith(expect.objectContaining({ role: "EDITOR", departmentId: DEPARTMENT_ID })));
  });

  it("shows the reason the API gives in Turkish and keeps the form open", async () => {
    createUser.mockRejectedValue(new ApiError(409, "EMAIL_TAKEN"));
    renderAdmin();
    const user_ = await openCreate();

    await user_.type(screen.getByLabelText(t.fullName), "Yeni Kişi");
    await user_.type(screen.getByLabelText(t.email), "yeni@example.com");
    await user_.click(screen.getByRole("button", { name: common.save }));

    expect(await screen.findByRole("alert")).toHaveTextContent(tr.errors.EMAIL_TAKEN);
    expect(screen.getByLabelText(t.fullName)).toBeInTheDocument();
  });

  it("edits a user with the email locked, and shows no password", async () => {
    updateUser.mockResolvedValue(user());
    renderAdmin();
    const user_ = userEvent.setup();

    await user_.click(await screen.findByRole("button", { name: `${common.edit}: Ayşe Yılmaz` }));
    expect(screen.getByLabelText(t.email)).toBeDisabled();
    expect(screen.queryByLabelText(t.password)).not.toBeInTheDocument();
    await user_.selectOptions(within(screen.getByRole("dialog")).getByLabelText(t.role), "APPROVER");
    await user_.click(screen.getByRole("button", { name: common.save }));

    await waitFor(() => expect(updateUser).toHaveBeenCalledWith("u1", { fullName: "Ayşe Yılmaz", role: "APPROVER", departmentId: DEPARTMENT_ID }));
  });

  it("does not let the administrator change the role of the own account", async () => {
    renderAdmin();
    await userEvent.click(await screen.findByRole("button", { name: `${common.edit}: Ben Yönetici` }));

    expect(within(screen.getByRole("dialog")).getByLabelText(t.role)).toBeDisabled();
    expect(screen.getByText(t.ownAccountHint)).toBeInTheDocument();
  });
});

describe("UserAdmin password reset and deactivation", () => {
  it("asks before resetting, then shows the new temporary password once", async () => {
    resetUserPassword.mockResolvedValue({ user: user({ mustChangePassword: true }), temporaryPassword: "ZyXwVuTs98765432" });
    renderAdmin();
    const user_ = userEvent.setup();

    await user_.click(await screen.findByRole("button", { name: `${t.resetPassword}: Ayşe Yılmaz` }));
    expect(screen.getByText(t.resetConfirm("Ayşe Yılmaz"))).toBeInTheDocument();
    expect(resetUserPassword).not.toHaveBeenCalled();
    await user_.click(within(screen.getByRole("dialog")).getByRole("button", { name: t.resetPassword }));

    await waitFor(() => expect(resetUserPassword).toHaveBeenCalledWith("u1", {}));
    expect(await screen.findByText("ZyXwVuTs98765432")).toBeInTheDocument();
  });

  it("sends a password of the administrator's choice, and refuses a short one", async () => {
    resetUserPassword.mockResolvedValue({ user: user(), temporaryPassword: null });
    renderAdmin();
    const user_ = userEvent.setup();

    await user_.click(await screen.findByRole("button", { name: `${t.resetPassword}: Ayşe Yılmaz` }));
    const dialog = screen.getByRole("dialog");
    await user_.type(within(dialog).getByLabelText(t.password), "short");
    await user_.click(within(dialog).getByRole("button", { name: t.resetPassword }));
    expect(screen.getByText(t.validation.passwordLength)).toBeInTheDocument();
    expect(resetUserPassword).not.toHaveBeenCalled();

    await user_.clear(within(dialog).getByLabelText(t.password));
    await user_.type(within(dialog).getByLabelText(t.password), "Chosen-Pass-77");
    await user_.click(within(dialog).getByRole("button", { name: t.resetPassword }));
    await waitFor(() => expect(resetUserPassword).toHaveBeenCalledWith("u1", { password: "Chosen-Pass-77" }));
  });

  it("asks before taking a user out of use, and says what stays", async () => {
    updateUser.mockResolvedValue(user({ isActive: false }));
    renderAdmin();
    const user_ = userEvent.setup();

    await user_.click(await screen.findByRole("button", { name: `${common.deactivate}: Ayşe Yılmaz` }));
    expect(screen.getByText(t.deactivateConfirm("Ayşe Yılmaz"))).toBeInTheDocument();
    expect(updateUser).not.toHaveBeenCalled();
    await user_.click(within(screen.getByRole("dialog")).getByRole("button", { name: common.deactivate }));

    await waitFor(() => expect(updateUser).toHaveBeenCalledWith("u1", { isActive: false }));
  });

  it("puts a user back in use", async () => {
    getAdminUsers.mockResolvedValue(page([user({ isActive: false })]));
    updateUser.mockResolvedValue(user());
    renderAdmin();
    const user_ = userEvent.setup();

    await user_.click(await screen.findByRole("button", { name: `${common.activate}: Ayşe Yılmaz` }));
    await user_.click(within(screen.getByRole("dialog")).getByRole("button", { name: common.activate }));

    await waitFor(() => expect(updateUser).toHaveBeenCalledWith("u1", { isActive: true }));
  });

  it("shows the reason the API gives when the last administrator would be removed", async () => {
    updateUser.mockRejectedValue(new ApiError(409, "LAST_ADMIN_PROTECTED"));
    renderAdmin();
    const user_ = userEvent.setup();

    await user_.click(await screen.findByRole("button", { name: `${common.deactivate}: Ayşe Yılmaz` }));
    await user_.click(within(screen.getByRole("dialog")).getByRole("button", { name: common.deactivate }));

    expect(await screen.findByRole("alert")).toHaveTextContent(tr.errors.LAST_ADMIN_PROTECTED);
  });
});
