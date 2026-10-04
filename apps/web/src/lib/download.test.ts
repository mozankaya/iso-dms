import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiDownload = vi.fn();
vi.mock("@/lib/api/client", () => ({ apiDownload: (path: string) => apiDownload(path) }));

import { downloadFromApi } from "./download";

let clicked: { href: string; download: string }[];

beforeEach(() => {
  vi.useFakeTimers();
  clicked = [];
  apiDownload.mockReset();
  URL.createObjectURL = vi.fn(() => "blob:fake-url");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push({ href: this.href, download: this.download });
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("downloadFromApi", () => {
  it("saves the blob under the name the server sent", async () => {
    const blob = new Blob(["x"]);
    apiDownload.mockResolvedValue({ blob, fileName: "PR-KK-001 Eğitim (Rev 1).docx" });

    await downloadFromApi("/revisions/r1/download", "fallback");

    expect(apiDownload).toHaveBeenCalledWith("/revisions/r1/download");
    expect(URL.createObjectURL).toHaveBeenCalledWith(blob);
    expect(clicked).toEqual([{ href: "blob:fake-url", download: "PR-KK-001 Eğitim (Rev 1).docx" }]);
  });

  it("uses the fallback name when the server sent none", async () => {
    apiDownload.mockResolvedValue({ blob: new Blob(["x"]), fileName: null });

    await downloadFromApi("/documents/d1/download", "PR-KK-001");

    expect(clicked[0].download).toBe("PR-KK-001");
  });

  it("leaves no link behind and releases the object URL afterwards", async () => {
    apiDownload.mockResolvedValue({ blob: new Blob(["x"]), fileName: "a.docx" });

    await downloadFromApi("/x", "fallback");

    expect(document.body.querySelector("a")).toBeNull();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:fake-url");
  });

  it("passes API errors on and saves nothing", async () => {
    apiDownload.mockRejectedValue(new Error("nope"));

    await expect(downloadFromApi("/x", "fallback")).rejects.toThrow("nope");

    expect(clicked).toEqual([]);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});
