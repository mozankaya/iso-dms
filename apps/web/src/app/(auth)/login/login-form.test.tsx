import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { tr } from "@/lib/i18n/tr";
import { LoginForm } from "./login-form";

const replace = vi.fn();
const login = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));
vi.mock("@/lib/auth/auth-context", () => ({
  useAuth: () => ({ status: "unauthenticated", user: null, login, logout: vi.fn() }),
}));

beforeEach(() => {
  replace.mockReset();
  login.mockReset();
});

describe("LoginForm", () => {
  it("shows Turkish validation messages for an empty form and does not call the API", async () => {
    render(<LoginForm />);

    await userEvent.click(screen.getByRole("button", { name: tr.auth.submit }));

    expect(await screen.findByText(tr.validation.emailRequired)).toBeInTheDocument();
    expect(screen.getByText(tr.validation.passwordRequired)).toBeInTheDocument();
    expect(login).not.toHaveBeenCalled();
  });

  it("rejects a malformed e-mail address", async () => {
    render(<LoginForm />);

    await userEvent.type(screen.getByLabelText(tr.auth.email), "not-an-email");
    await userEvent.type(screen.getByLabelText(tr.auth.password), "secret");
    await userEvent.click(screen.getByRole("button", { name: tr.auth.submit }));

    expect(await screen.findByText(tr.validation.emailInvalid)).toBeInTheDocument();
    expect(login).not.toHaveBeenCalled();
  });

  it("logs in and redirects to the home page", async () => {
    login.mockResolvedValueOnce(undefined);
    render(<LoginForm />);

    await userEvent.type(screen.getByLabelText(tr.auth.email), "  admin@example.com ");
    await userEvent.type(screen.getByLabelText(tr.auth.password), "secret");
    await userEvent.click(screen.getByRole("button", { name: tr.auth.submit }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(login).toHaveBeenCalledWith("admin@example.com", "secret");
  });

  it("shows the translated API error for wrong credentials", async () => {
    login.mockRejectedValueOnce(new ApiError(401, "INVALID_CREDENTIALS"));
    render(<LoginForm />);

    await userEvent.type(screen.getByLabelText(tr.auth.email), "admin@example.com");
    await userEvent.type(screen.getByLabelText(tr.auth.password), "wrong");
    await userEvent.click(screen.getByRole("button", { name: tr.auth.submit }));

    expect(await screen.findByRole("alert")).toHaveTextContent(tr.errors.INVALID_CREDENTIALS);
    expect(replace).not.toHaveBeenCalled();
  });

  it("shows a connection error when the server is unreachable", async () => {
    login.mockRejectedValueOnce(new TypeError("fetch failed"));
    render(<LoginForm />);

    await userEvent.type(screen.getByLabelText(tr.auth.email), "admin@example.com");
    await userEvent.type(screen.getByLabelText(tr.auth.password), "secret");
    await userEvent.click(screen.getByRole("button", { name: tr.auth.submit }));

    expect(await screen.findByRole("alert")).toHaveTextContent(tr.errors.NETWORK);
  });
});
