import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tr } from "@/lib/i18n/tr";
import { HeaderSearch } from "./header-search";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const t = tr.search;

beforeEach(() => push.mockClear());

describe("HeaderSearch", () => {
  it("opens the search page with the words, trimmed and encoded", async () => {
    render(<HeaderSearch />);

    await userEvent.type(screen.getByRole("searchbox", { name: t.inputLabel }), '  "saklama süresi" PR-KK  {Enter}');

    expect(push).toHaveBeenCalledWith("/search?q=%22saklama+s%C3%BCresi%22+PR-KK");
  });

  it("does nothing for fewer than two characters", async () => {
    render(<HeaderSearch />);

    await userEvent.type(screen.getByRole("searchbox", { name: t.inputLabel }), "a{Enter}");

    expect(push).not.toHaveBeenCalled();
  });
});
