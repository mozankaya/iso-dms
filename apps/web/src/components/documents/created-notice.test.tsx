import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tr } from "@/lib/i18n/tr";
import { CreatedNotice } from "./created-notice";

const replace = vi.fn();
let currentSearch = "";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => "/categories/procedures",
  useSearchParams: () => new URLSearchParams(currentSearch),
}));

beforeEach(() => {
  replace.mockReset();
  currentSearch = "";
});

describe("CreatedNotice", () => {
  it("renders nothing without a created code", () => {
    const { container } = render(<CreatedNotice />);
    expect(container).toBeEmptyDOMElement();
  });

  it("announces the created document", () => {
    currentSearch = "created=PR-KK-007";
    render(<CreatedNotice />);

    expect(screen.getByRole("status")).toHaveTextContent(tr.newDocument.created("PR-KK-007"));
  });

  it("removes only its own parameter when dismissed", async () => {
    currentSearch = "q=form&created=PR-KK-007&page=2";
    render(<CreatedNotice />);

    await userEvent.click(screen.getByRole("button", { name: tr.newDocument.dismiss }));

    expect(replace).toHaveBeenCalledWith("/categories/procedures?q=form&page=2", { scroll: false });
  });

  it("goes back to the plain path when nothing else is left", async () => {
    currentSearch = "created=PR-KK-007";
    render(<CreatedNotice />);

    await userEvent.click(screen.getByRole("button", { name: tr.newDocument.dismiss }));

    expect(replace).toHaveBeenCalledWith("/categories/procedures", { scroll: false });
  });
});
