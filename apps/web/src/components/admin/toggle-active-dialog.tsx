"use client";

import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { ApiError } from "@/lib/api/client";
import { errorMessage, tr } from "@/lib/i18n/tr";

export interface ToggleTarget {
  id: string;
  isActive: boolean;
}

function ToggleForm({
  message,
  confirmLabel,
  destructive,
  run,
  onDone,
  onClose,
}: {
  message: string;
  confirmLabel: string;
  destructive: boolean;
  run: () => Promise<unknown>;
  onDone: () => Promise<void> | void;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({ mutationFn: run });

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await mutation.mutateAsync();
    } catch (caught) {
      setError(caught instanceof ApiError ? errorMessage(caught) : tr.errors.NETWORK);
      return;
    }
    await onDone();
    onClose();
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <p className="text-sm">{message}</p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>
          {tr.admin.common.cancel}
        </Button>
        <Button type="submit" variant={destructive ? "destructive" : "default"} disabled={mutation.isPending}>
          {mutation.isPending ? tr.admin.common.saving : confirmLabel}
        </Button>
      </div>
    </form>
  );
}

/**
 * Confirmation for taking a department or category out of use and back. Nothing is deleted (PROJECT.md 6.9),
 * so the message says what stays as it is. The form lives only while the dialog is open.
 */
export function ToggleActiveDialog<T extends ToggleTarget>({
  target,
  titles,
  messageFor,
  run,
  onDone,
  onClose,
}: {
  target: T | null;
  titles: { deactivate: string; activate: string };
  messageFor: (target: T) => string;
  run: (target: T) => Promise<unknown>;
  onDone: () => Promise<void> | void;
  onClose: () => void;
}) {
  const deactivating = target?.isActive ?? true;
  return (
    <Modal open={target !== null} onClose={onClose} title={deactivating ? titles.deactivate : titles.activate}>
      {target && (
        <ToggleForm
          key={target.id}
          message={messageFor(target)}
          confirmLabel={deactivating ? tr.admin.common.deactivate : tr.admin.common.activate}
          destructive={deactivating}
          run={() => run(target)}
          onDone={onDone}
          onClose={onClose}
        />
      )}
    </Modal>
  );
}
