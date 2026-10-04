import { apiDownload } from "@/lib/api/client";

/** Fetches a file from the API (with the user's token) and hands it to the browser as a download. */
export async function downloadFromApi(path: string, fallbackName: string): Promise<void> {
  const { blob, fileName } = await apiDownload(path);

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName ?? fallbackName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoke after the click had its chance to start the download
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
