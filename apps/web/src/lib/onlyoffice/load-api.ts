/** Minimal typing of the parts of the ONLYOFFICE browser API this app uses. */
export interface DocEditorInstance {
  destroyEditor(): void;
}

export interface DocEditorEvents {
  onAppReady?: () => void;
  onError?: (event: { data?: { errorCode?: number; errorDescription?: string } }) => void;
}

declare global {
  interface Window {
    DocsAPI?: {
      DocEditor: new (elementId: string, config: Record<string, unknown>) => DocEditorInstance;
    };
  }
}

const ONLYOFFICE_URL = (process.env.NEXT_PUBLIC_ONLYOFFICE_URL ?? "http://localhost:8080").replace(/\/+$/, "");

let loading: Promise<void> | null = null;

/**
 * Loads api.js from the document server once. A failed load is not remembered, so the user can retry
 * after starting the service.
 */
export function loadOnlyOfficeApi(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("The editor only runs in the browser"));
  if (window.DocsAPI) return Promise.resolve();

  loading ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `${ONLYOFFICE_URL}/web-apps/apps/api/documents/api.js`;
    script.async = true;
    script.onload = () => (window.DocsAPI ? resolve() : reject(new Error("DocsAPI is missing")));
    script.onerror = () => {
      script.remove();
      reject(new Error("api.js could not be loaded"));
    };
    document.head.appendChild(script);
  }).catch((error) => {
    loading = null;
    throw error;
  });
  return loading;
}
