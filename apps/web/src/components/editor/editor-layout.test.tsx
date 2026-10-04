import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tr } from "@/lib/i18n/tr";
import { EditorLayout } from "./editor-layout";

const replace = vi.fn();
let status: "loading" | "authenticated" | "unauthenticated" = "authenticated";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));
vi.mock("@/lib/auth/auth-context", () => ({
  useAuth: () => ({ status, user: null, login: vi.fn(), logout: vi.fn() }),
}));

beforeEach(() => {
  replace.mockReset();
  status = "authenticated";
});

describe("EditorLayout", () => {
  it("renders the page for a signed-in user", () => {
    render(<EditorLayout>page</EditorLayout>);

    expect(screen.getByText("page")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("holds the page back while the session is being restored", () => {
    status = "loading";
    render(<EditorLayout>page</EditorLayout>);

    expect(screen.queryByText("page")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(tr.common.loading);
    expect(replace).not.toHaveBeenCalled();
  });

  it("sends visitors without a session to the login page", () => {
    status = "unauthenticated";
    render(<EditorLayout>page</EditorLayout>);

    expect(screen.queryByText("page")).not.toBeInTheDocument();
    expect(replace).toHaveBeenCalledWith("/login");
  });
});
