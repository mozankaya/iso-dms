"use client";

import { Download } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api/client";
import { downloadFromApi } from "@/lib/download";
import { errorMessage, tr } from "@/lib/i18n/tr";

/** Downloads a file through the API with the user's token; shows a short error next to the button. */
export function DownloadButton({
  path,
  fallbackName,
  ariaLabel,
  variant = "outline",
}: {
  path: string;
  /** Used when the server does not send a file name */
  fallbackName: string;
  ariaLabel?: string;
  variant?: "outline" | "ghost";
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setBusy(true);
    setError(null);
    try {
      await downloadFromApi(path, fallbackName);
    } catch (caught) {
      setError(caught instanceof ApiError ? errorMessage(caught) : tr.errors.NETWORK);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button variant={variant} size="sm" onClick={download} disabled={busy} aria-label={ariaLabel}>
        <Download className="mr-1.5 h-4 w-4" aria-hidden="true" />
        {busy ? tr.detail.downloading : tr.detail.download}
      </Button>
      {error && (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      )}
    </span>
  );
}
