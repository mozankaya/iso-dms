import type { SessionUserDto } from "@iso-dms/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tr } from "@/lib/i18n/tr";
import { NewDocumentPage } from "./new-document-page";

let currentUser: SessionUserDto | null;
let search = "";
const getCategories = vi.fn();
const getDepartments = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(search),
}));
vi.mock("@/lib/auth/auth-context", () => ({
  useAuth: () => ({ status: "authenticated", user: currentUser, login: vi.fn(), logout: vi.fn() }),
}));
vi.mock("@/lib/api/endpoints", () => ({
  getCategories: () => getCategories(),
  getDepartments: () => getDepartments(),
  getTemplates: () => Promise.resolve([]),
  createDocument: vi.fn(),
  uploadDocument: vi.fn(),
}));

function user(overrides: Partial<SessionUserDto>): SessionUserDto {
  return {
    id: "u1",
    organizationId: "o1",
    departmentId: "dep-kk",
    email: "a@b.c",
    fullName: "T",
    role: "EDITOR",
    ...overrides,
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NewDocumentPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  search = "";
  currentUser = user({});
  getCategories.mockReset();
  getDepartments.mockReset();
  getCategories.mockResolvedValue([
    {
      id: "cat-pr",
      name: "Prosedürler",
      slug: "procedures",
      codePrefix: "PR",
      description: null,
      icon: null,
      sortOrder: 1,
      isExternal: false,
      externalUrl: null,
      documentCount: 0,
    },
  ]);
  getDepartments.mockResolvedValue([{ id: "dep-kk", name: "Kalite Koordinatörlüğü", code: "KK" }]);
});

describe("NewDocumentPage", () => {
  it("does not offer the form to readers", () => {
    currentUser = user({ role: "READER" });
    renderPage();

    expect(screen.getByRole("alert")).toHaveTextContent(tr.errors.FORBIDDEN);
    expect(screen.queryByLabelText(tr.newDocument.documentTitle)).not.toBeInTheDocument();
  });

  it("tells an editor without a department to contact an administrator", () => {
    currentUser = user({ departmentId: null });
    renderPage();

    expect(screen.getByRole("alert")).toHaveTextContent(tr.newDocument.noDepartment);
  });

  it("does not require a department for quality managers", async () => {
    currentUser = user({ role: "QUALITY_MANAGER", departmentId: null });
    renderPage();

    expect(await screen.findByLabelText(tr.newDocument.documentTitle)).toBeInTheDocument();
  });

  it("opens the form with the category from the URL", async () => {
    search = "category=procedures";
    renderPage();

    expect(await screen.findByLabelText(tr.newDocument.category)).toHaveValue("cat-pr");
  });

  it("shows an error with a retry button when reference data cannot be loaded", async () => {
    getCategories.mockRejectedValue(new Error("boom"));
    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent(tr.errors.UNKNOWN);
    expect(screen.getByRole("button", { name: tr.common.retry })).toBeInTheDocument();
  });
});
