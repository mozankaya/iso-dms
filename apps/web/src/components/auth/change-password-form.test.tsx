import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { tr } from "@/lib/i18n/tr";
import { ChangePasswordForm } from "./change-password-form";

const t = tr.auth.changePassword;
const replace = vi.fn();
const changePassword = vi.fn();
let mustChangePassword = true;

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));
vi.mock("@/lib/auth/use-require-auth", () => ({
  useRequireAuth: () => ({ status: "authenticated", user: { id: "u1", mustChangePassword } }),
}));
vi.mock("@/lib/auth/auth-context", () => ({ useAuth: () => ({ changePassword }) }));

async function fill(current: string, next: string, confirm: string) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(t.current), current);
  await user.type(screen.getByLabelText(t.next), next);
  await user.type(screen.getByLabelText(t.confirm), confirm);
  await user.click(screen.getByRole("button", { name: t.submit }));
}

beforeEach(() => {
  replace.mockReset();
  changePassword.mockReset();
  mustChangePassword = true;
});

describe("ChangePasswordForm", () => {
  it("explains why a user with a temporary password is here, and offers no way back", () => {
    render(<ChangePasswordForm />);
    expect(screen.getByText(t.forcedSubtitle)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: t.cancel })).not.toBeInTheDocument();
  });

  it("lets anybody else go back", () => {
    mustChangePassword = false;
    render(<ChangePasswordForm />);
    expect(screen.getByText(t.subtitle)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: t.cancel })).toHaveAttribute("href", "/");
  });

  it("changes the password and goes home", async () => {
    changePassword.mockResolvedValue(undefined);
    render(<ChangePasswordForm />);

    await fill("Temp-Password-1", "My-Own-Password-1", "My-Own-Password-1");

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(changePassword).toHaveBeenCalledWith("Temp-Password-1", "My-Own-Password-1");
  });

  it.each([
    ["a short new password", ["Temp-Password-1", "short", "short"], tr.validation.passwordTooShort],
    ["a confirmation that differs", ["Temp-Password-1", "My-Own-Password-1", "My-Own-Password-2"], tr.validation.passwordMismatch],
    ["the same password again", ["Temp-Password-1", "Temp-Password-1", "Temp-Password-1"], tr.validation.passwordSame],
  ])("does not send %s", async (_label, [current, next, confirm], message) => {
    render(<ChangePasswordForm />);

    await fill(current, next, confirm);

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(changePassword).not.toHaveBeenCalled();
  });

  it("asks for the current password", async () => {
    render(<ChangePasswordForm />);
    await userEvent.click(screen.getByRole("button", { name: t.submit }));
    expect(await screen.findByText(tr.validation.passwordRequired)).toBeInTheDocument();
  });

  it("shows the reason the API gives in Turkish and stays", async () => {
    changePassword.mockRejectedValue(new ApiError(400, "CURRENT_PASSWORD_INCORRECT"));
    render(<ChangePasswordForm />);

    await fill("Wrong-Password-1", "My-Own-Password-1", "My-Own-Password-1");

    expect(await screen.findByRole("alert")).toHaveTextContent(tr.errors.CURRENT_PASSWORD_INCORRECT);
    expect(replace).not.toHaveBeenCalled();
  });
});
