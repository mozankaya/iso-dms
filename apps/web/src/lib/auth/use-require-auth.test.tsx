import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRequireAuth } from "./use-require-auth";

const replace = vi.fn();
let auth: { status: string; user: { mustChangePassword: boolean } | null };

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));
vi.mock("@/lib/auth/auth-context", () => ({ useAuth: () => auth }));

beforeEach(() => {
  replace.mockReset();
  auth = { status: "authenticated", user: { mustChangePassword: false } };
});

describe("useRequireAuth", () => {
  it("leaves a signed-in user where they are", () => {
    renderHook(() => useRequireAuth());
    expect(replace).not.toHaveBeenCalled();
  });

  it("sends visitors without a session to the login page", () => {
    auth = { status: "unauthenticated", user: null };
    renderHook(() => useRequireAuth());
    expect(replace).toHaveBeenCalledWith("/login");
  });

  it("does not decide while the session is still being restored", () => {
    auth = { status: "loading", user: null };
    renderHook(() => useRequireAuth());
    expect(replace).not.toHaveBeenCalled();
  });

  it("sends a user with a temporary password to the page where it is replaced", () => {
    auth = { status: "authenticated", user: { mustChangePassword: true } };
    renderHook(() => useRequireAuth());
    expect(replace).toHaveBeenCalledWith("/change-password");
  });

  it("lets that page itself stay", () => {
    auth = { status: "authenticated", user: { mustChangePassword: true } };
    renderHook(() => useRequireAuth({ allowPasswordChange: true }));
    expect(replace).not.toHaveBeenCalled();
  });
});
