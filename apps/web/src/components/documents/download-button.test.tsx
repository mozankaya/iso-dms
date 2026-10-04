import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { tr } from "@/lib/i18n/tr";
import { DownloadButton } from "./download-button";

const downloadFromApi = vi.fn();
vi.mock("@/lib/download", () => ({ downloadFromApi: (path: string, name: string) => downloadFromApi(path, name) }));

beforeEach(() => {
  downloadFromApi.mockReset();
  downloadFromApi.mockResolvedValue(undefined);
});

describe("DownloadButton", () => {
  it("downloads the file of its path", async () => {
    render(<DownloadButton path="/revisions/r1/download" fallbackName="PR-KK-001" />);

    await userEvent.click(screen.getByRole("button", { name: tr.detail.download }));

    expect(downloadFromApi).toHaveBeenCalledWith("/revisions/r1/download", "PR-KK-001");
  });

  it("is disabled while the download runs", async () => {
    let finish: () => void = () => undefined;
    downloadFromApi.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    render(<DownloadButton path="/x" fallbackName="x" />);

    await userEvent.click(screen.getByRole("button", { name: tr.detail.download }));

    expect(screen.getByRole("button", { name: tr.detail.downloading })).toBeDisabled();
    finish();
    await waitFor(() => expect(screen.getByRole("button", { name: tr.detail.download })).toBeEnabled());
  });

  it("explains an API refusal in Turkish and can be tried again", async () => {
    downloadFromApi.mockRejectedValueOnce(new ApiError(404, "REVISION_FILE_MISSING"));
    render(<DownloadButton path="/x" fallbackName="x" />);

    await userEvent.click(screen.getByRole("button", { name: tr.detail.download }));
    expect(await screen.findByRole("alert")).toHaveTextContent(tr.errors.REVISION_FILE_MISSING);

    await userEvent.click(screen.getByRole("button", { name: tr.detail.download }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(downloadFromApi).toHaveBeenCalledTimes(2);
  });

  it("explains a connection problem", async () => {
    downloadFromApi.mockRejectedValueOnce(new TypeError("fetch failed"));
    render(<DownloadButton path="/x" fallbackName="x" />);

    await userEvent.click(screen.getByRole("button", { name: tr.detail.download }));

    expect(await screen.findByRole("alert")).toHaveTextContent(tr.errors.NETWORK);
  });

  it("can carry a more specific accessible name", () => {
    render(<DownloadButton path="/x" fallbackName="x" ariaLabel="İndir (Revizyon 2)" />);
    expect(screen.getByRole("button", { name: "İndir (Revizyon 2)" })).toBeInTheDocument();
  });
});
