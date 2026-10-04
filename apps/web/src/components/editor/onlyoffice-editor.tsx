"use client";

import { useEffect, useEffectEvent, useRef } from "react";
import type { DocEditorInstance } from "@/lib/onlyoffice/load-api";

/**
 * Hosts the ONLYOFFICE editor. The document server replaces the element it is attached to with an
 * iframe, which React must not manage: the editor gets a throw-away element inside a container that
 * React renders empty, and everything inside is dropped again on cleanup (also keeps strict mode's
 * double mount safe).
 *
 * `config` is the signed configuration from the API. It carries short-lived tokens, so a new config
 * object recreates the editor and callers must keep passing the same object while the user works.
 */
export function OnlyOfficeEditor({
  config,
  onError,
}: {
  config: Record<string, unknown>;
  onError: (description: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Always calls the latest callback without recreating the editor when it changes
  const reportError = useEffectEvent(onError);

  useEffect(() => {
    const container = containerRef.current;
    const DocsAPI = window.DocsAPI;
    if (!container || !DocsAPI) return;

    const target = document.createElement("div");
    target.id = `onlyoffice-${crypto.randomUUID()}`;
    container.appendChild(target);

    let editor: DocEditorInstance | undefined;
    try {
      editor = new DocsAPI.DocEditor(target.id, {
        ...config,
        width: "100%",
        height: "100%",
        events: {
          onError: (event: { data?: { errorDescription?: string } }) =>
            reportError(event.data?.errorDescription ?? ""),
        },
      });
    } catch (error) {
      reportError((error as Error).message);
    }

    return () => {
      try {
        editor?.destroyEditor();
      } catch {
        // the editor may already be gone (e.g. its iframe was removed)
      }
      container.replaceChildren();
    };
  }, [config]);

  return <div ref={containerRef} className="h-full w-full" />;
}
