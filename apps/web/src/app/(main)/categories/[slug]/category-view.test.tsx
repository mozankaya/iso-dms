import type { CategoryDto, UserRole } from "@iso-dms/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tr } from "@/lib/i18n/tr";
import { CategoryView } from "./category-view";

let role: UserRole = "EDITOR";

vi.mock("@/components/documents/document-list", () => ({ DocumentList: () => <div>document list</div> }));
vi.mock("@/lib/auth/auth-context", () => ({
  useAuth: () => ({ status: "authenticated", user: { id: "u1", role }, login: vi.fn(), logout: vi.fn() }),
}));
vi.mock("@/lib/api/endpoints", () => ({
  getCategories: () =>
    Promise.resolve<CategoryDto[]>([
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
    ]),
}));

function renderView(slug: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CategoryView slug={slug} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  role = "EDITOR";
});

describe("CategoryView", () => {
  it.each(["EDITOR", "APPROVER", "QUALITY_MANAGER", "ADMIN"] as const)("offers a new document to %s", async (value) => {
    role = value;
    renderView("procedures");

    const link = await screen.findByRole("link", { name: tr.newDocument.button });
    expect(link).toHaveAttribute("href", "/documents/new?category=procedures");
  });

  it("does not offer a new document to readers", async () => {
    role = "READER";
    renderView("procedures");

    expect(await screen.findByRole("heading", { name: "Prosedürler" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: tr.newDocument.button })).not.toBeInTheDocument();
  });

  it("says so when the category does not exist", async () => {
    renderView("missing");
    expect(await screen.findByText(tr.category.notFound)).toBeInTheDocument();
  });
});
