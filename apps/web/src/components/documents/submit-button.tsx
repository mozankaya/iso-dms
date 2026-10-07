"use client";

import type { OpenRevisionDto } from "@iso-dms/shared";
import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { ApiError } from "@/lib/api/client";
import { submitRevision } from "@/lib/api/endpoints";
import { invalidateAfterApprovalChange } from "@/lib/documents/invalidate";
import { errorMessage, tr } from "@/lib/i18n/tr";

const t = tr.submit;

/** The editor reports its last save a few seconds after it is closed: the send waits for that, but not forever. */
const RETRY_INTERVAL_MS = 2000;
const MAX_WAIT_MS = 30_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * "Onaya Gönder" with a confirmation. A draft cannot be locked while somebody still edits it, or while the
 * editor's last save is on its way: in that case the request is repeated for a while (the author has just closed
 * the editor), and only then reported. Other refusals stay in the dialog.
 */
export function SubmitButton({
  documentId,
  code,
  revision,
  autoOpen = false,
}: {
  documentId: string;
  code: string;
  revision: OpenRevisionDto;
  /** Opens the dialog right away (the editor sends the author here) */
  autoOpen?: boolean;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(autoOpen);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function openDialog() {
    setError(null);
    setWaiting(false);
    setOpen(true);
  }

  async function submitWhenIdle() {
    const deadline = Date.now() + MAX_WAIT_MS;
    for (;;) {
      try {
        return await submitRevision(revision.id);
      } catch (caught) {
        const stillSaving = caught instanceof ApiError && caught.code === "EDITOR_SESSION_ACTIVE";
        if (!stillSaving || Date.now() >= deadline || !mounted.current) throw caught;
        setWaiting(true);
        await sleep(RETRY_INTERVAL_MS);
      }
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await submitWhenIdle();
      await invalidateAfterApprovalChange(queryClient, documentId);
      if (mounted.current) setOpen(false);
    } catch (caught) {
      if (mounted.current) setError(caught instanceof ApiError ? errorMessage(caught) : tr.errors.NETWORK);
    } finally {
      if (mounted.current) {
        setBusy(false);
        setWaiting(false);
      }
    }
  }

  return (
    <>
      <Button onClick={openDialog}>{t.button}</Button>

      <Modal open={open} onClose={() => setOpen(false)} title={t.dialogTitle}>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <p className="text-sm">{t.confirm(code, revision.revisionNo)}</p>

          {waiting && (
            <p role="status" className="text-sm text-muted">
              {t.saving}
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              {t.cancel}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? t.submitting : t.submit}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
