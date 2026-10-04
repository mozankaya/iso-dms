import type { ApiErrorBody, AuthResponseDto } from "@iso-dms/shared";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code?: string,
    message?: string,
  ) {
    super(message ?? `Request failed with status ${status}`);
  }
}

let accessToken: string | null = null;
let refreshInFlight: Promise<AuthResponseDto> | null = null;
let onUnauthorized: (() => void) | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

/** Called when the session can no longer be refreshed (the user must log in again). */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

async function parseError(response: Response): Promise<ApiError> {
  let body: Partial<ApiErrorBody> = {};
  try {
    body = await response.json();
  } catch {
    // Non-JSON error body
  }
  const message = Array.isArray(body.message) ? body.message.join(", ") : body.message;
  return new ApiError(response.status, body.code, message);
}

async function send(path: string, init: RequestInit, withToken: boolean): Promise<Response> {
  const headers = new Headers(init.headers);
  // FormData needs the browser to set the multipart boundary itself
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (withToken && accessToken) {
    headers.set("Authorization", `Bearer ${accessToken}`);
  }
  return fetch(`${API_URL}${path}`, { ...init, headers, credentials: "include" });
}

/**
 * Refreshes the session using the httpOnly cookie. Concurrent callers share one request:
 * the server rotates the refresh token, so a second parallel call would look like token reuse
 * and revoke the whole session.
 */
export function refreshSession(): Promise<AuthResponseDto> {
  refreshInFlight ??= (async () => {
    try {
      const response = await send("/auth/refresh", { method: "POST" }, false);
      if (!response.ok) throw await parseError(response);
      const session = (await response.json()) as AuthResponseDto;
      accessToken = session.accessToken;
      return session;
    } catch (error) {
      accessToken = null;
      throw error;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

/** Authenticated request: refreshes the session once on 401 and retries. Throws ApiError for error statuses. */
async function authenticatedRequest(path: string, init: RequestInit): Promise<Response> {
  let response = await send(path, init, true);

  if (response.status === 401 && accessToken) {
    try {
      await refreshSession();
    } catch {
      onUnauthorized?.();
      throw new ApiError(401, "INVALID_REFRESH_TOKEN");
    }
    response = await send(path, init, true);
  }

  if (!response.ok) throw await parseError(response);
  return response;
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await authenticatedRequest(path, init);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** Downloads a file with the user's token; the file name comes from the Content-Disposition header. */
export async function apiDownload(path: string): Promise<{ blob: Blob; fileName: string | null }> {
  const response = await authenticatedRequest(path, {});
  return {
    blob: await response.blob(),
    fileName: parseContentDispositionFileName(response.headers.get("Content-Disposition")),
  };
}

/**
 * File name from a Content-Disposition header. The UTF-8 form (filename*) wins because it carries
 * Turkish characters intact; the plain form is the ASCII fallback.
 */
export function parseContentDispositionFileName(header: string | null): string | null {
  if (!header) return null;

  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1].trim());
    } catch {
      // malformed escape sequence: use the fallback
    }
  }
  const plain = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/i.exec(header);
  return (plain?.[1] ?? plain?.[2])?.trim() || null;
}

/** Requests that must not trigger a refresh (login, logout). */
export async function apiFetchPublic<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await send(path, init, false);
  if (!response.ok) throw await parseError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
