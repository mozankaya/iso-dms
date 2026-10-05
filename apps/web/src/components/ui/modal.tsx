"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * Modal dialog on top of the native <dialog> element: the browser handles focus trapping, the Escape key
 * and the backdrop. `open` is the source of truth; the dialog reports closing (Escape) through onClose.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="modal-title"
      onClose={onClose}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-lg border border-border bg-card p-0 text-foreground shadow-lg backdrop:bg-black/40"
    >
      {open && (
        <div className="space-y-4 p-5">
          <h2 id="modal-title" className="text-lg font-semibold">
            {title}
          </h2>
          {children}
        </div>
      )}
    </dialog>
  );
}
