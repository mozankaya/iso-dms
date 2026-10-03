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
  if (init.body && !headers.has("Content-Type")) {
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

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
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
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** Requests that must not trigger a refresh (login, logout). */
export async function apiFetchPublic<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await send(path, init, false);
  if (!response.ok) throw await parseError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
