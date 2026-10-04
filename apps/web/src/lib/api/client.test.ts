import { beforeEach, describe, expect, it, vi } from "vitest";

const SESSION_USER = {
  id: "u1",
  organizationId: "o1",
  departmentId: null,
  email: "a@b.c",
  fullName: "A B",
  role: "READER",
};

function json(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function refreshOk(token: string): Response {
  return json(200, { accessToken: token, user: SESSION_USER });
}

type FetchMock = ReturnType<typeof vi.fn>;
let fetchMock: FetchMock;
let client: typeof import("./client");

function authHeader(call: unknown[]): string | null {
  return new Headers((call[1] as RequestInit).headers).get("Authorization");
}

beforeEach(async () => {
  vi.resetModules(); // the client keeps the access token in module state
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  client = await import("./client");
});

describe("apiFetch", () => {
  it("sends the access token as a bearer header and includes cookies", async () => {
    client.setAccessToken("token-1");
    fetchMock.mockResolvedValueOnce(json(200, { ok: true }));

    await expect(client.apiFetch("/categories")).resolves.toEqual({ ok: true });

    expect(authHeader(fetchMock.mock.calls[0])).toBe("Bearer token-1");
    expect((fetchMock.mock.calls[0][1] as RequestInit).credentials).toBe("include");
  });

  it("refreshes once on 401 and retries the request with the new token", async () => {
    client.setAccessToken("expired");
    fetchMock
      .mockResolvedValueOnce(json(401, { statusCode: 401, code: "INVALID_TOKEN" }))
      .mockResolvedValueOnce(refreshOk("fresh"))
      .mockResolvedValueOnce(json(200, { ok: true }));

    await expect(client.apiFetch("/categories")).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[1][0])).toContain("/auth/refresh");
    expect(authHeader(fetchMock.mock.calls[2])).toBe("Bearer fresh");
    expect(client.getAccessToken()).toBe("fresh");
  });

  it("shares a single refresh request between concurrent 401 responses", async () => {
    client.setAccessToken("expired");
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (String(url).includes("/auth/refresh")) return refreshOk("fresh");
      const bearer = new Headers(init.headers).get("Authorization");
      return bearer === "Bearer fresh" ? json(200, { ok: true }) : json(401, { statusCode: 401 });
    });

    await Promise.all([client.apiFetch("/categories"), client.apiFetch("/dashboard/stats")]);

    const refreshCalls = fetchMock.mock.calls.filter((call) => String(call[0]).includes("/auth/refresh"));
    expect(refreshCalls).toHaveLength(1);
  });

  it("clears the session and notifies when the refresh fails", async () => {
    const handler = vi.fn();
    client.setUnauthorizedHandler(handler);
    client.setAccessToken("expired");
    fetchMock
      .mockResolvedValueOnce(json(401, { statusCode: 401 }))
      .mockResolvedValueOnce(json(401, { statusCode: 401, code: "INVALID_REFRESH_TOKEN" }));

    await expect(client.apiFetch("/categories")).rejects.toMatchObject({ status: 401 });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(client.getAccessToken()).toBeNull();
  });

  it("does not try to refresh when there is no access token", async () => {
    fetchMock.mockResolvedValueOnce(json(401, { statusCode: 401, code: "UNAUTHORIZED" }));

    await expect(client.apiFetch("/categories")).rejects.toMatchObject({ status: 401, code: "UNAUTHORIZED" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("exposes the machine-readable error code", async () => {
    client.setAccessToken("token");
    fetchMock.mockResolvedValueOnce(json(403, { statusCode: 403, code: "FORBIDDEN", message: "x" }));

    await expect(client.apiFetch("/x")).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
  });
});

describe("parseContentDispositionFileName", () => {
  it("prefers the UTF-8 name, which keeps Turkish characters", () => {
    const header = `attachment; filename="PR-KK-001 Egitim (Rev 1).docx"; filename*=UTF-8''PR-KK-001%20E%C4%9Fitim%20%28Rev%201%29.docx`;
    expect(client.parseContentDispositionFileName(header)).toBe("PR-KK-001 Eğitim (Rev 1).docx");
  });

  it("falls back to the plain name", () => {
    expect(client.parseContentDispositionFileName('attachment; filename="report.docx"')).toBe("report.docx");
    expect(client.parseContentDispositionFileName("attachment; filename=report.docx")).toBe("report.docx");
  });

  it("falls back to the plain name when the UTF-8 name is malformed", () => {
    expect(client.parseContentDispositionFileName(`attachment; filename="a.docx"; filename*=UTF-8''%E0%A4%A`)).toBe("a.docx");
  });

  it("returns null when there is no usable name", () => {
    expect(client.parseContentDispositionFileName(null)).toBeNull();
    expect(client.parseContentDispositionFileName("attachment")).toBeNull();
    expect(client.parseContentDispositionFileName('attachment; filename=""')).toBeNull();
  });
});

describe("apiDownload", () => {
  it("returns the file and the name the server chose, using the user's token", async () => {
    client.setAccessToken("token-1");
    fetchMock.mockResolvedValueOnce(
      new Response("file content", {
        status: 200,
        headers: { "Content-Disposition": `attachment; filename*=UTF-8''%C5%9Eablon.docx` },
      }),
    );

    const { blob, fileName } = await client.apiDownload("/revisions/r1/download");

    expect(fileName).toBe("Şablon.docx");
    expect(await blob.text()).toBe("file content");
    expect(authHeader(fetchMock.mock.calls[0])).toBe("Bearer token-1");
  });

  it("refreshes the session once when the token expired, like any other request", async () => {
    client.setAccessToken("expired");
    fetchMock
      .mockResolvedValueOnce(json(401, { statusCode: 401 }))
      .mockResolvedValueOnce(refreshOk("fresh"))
      .mockResolvedValueOnce(new Response("data", { status: 200 }));

    const { fileName } = await client.apiDownload("/revisions/r1/download");

    expect(fileName).toBeNull();
    expect(authHeader(fetchMock.mock.calls[2])).toBe("Bearer fresh");
  });

  it("throws the API error with its code", async () => {
    client.setAccessToken("token");
    fetchMock.mockResolvedValueOnce(json(404, { statusCode: 404, code: "REVISION_FILE_MISSING" }));

    await expect(client.apiDownload("/revisions/r1/download")).rejects.toMatchObject({
      status: 404,
      code: "REVISION_FILE_MISSING",
    });
  });
});

describe("request bodies", () => {
  it("lets the browser set the multipart boundary for FormData", async () => {
    client.setAccessToken("token");
    fetchMock.mockResolvedValueOnce(json(201, { ok: true }));
    const body = new FormData();
    body.set("file", new File(["x"], "a.docx"));

    await client.apiFetch("/documents/upload", { method: "POST", body });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.body).toBe(body);
    expect(new Headers(init.headers).has("Content-Type")).toBe(false);
  });

  it("sends JSON bodies as application/json", async () => {
    client.setAccessToken("token");
    fetchMock.mockResolvedValueOnce(json(201, { ok: true }));

    await client.apiFetch("/documents", { method: "POST", body: JSON.stringify({ a: 1 }) });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
  });
});

describe("apiFetchPublic", () => {
  it("never refreshes: a 401 from login is a credentials error", async () => {
    client.setAccessToken("token");
    fetchMock.mockResolvedValueOnce(json(401, { statusCode: 401, code: "INVALID_CREDENTIALS" }));

    await expect(client.apiFetchPublic("/auth/login", { method: "POST", body: "{}" })).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(authHeader(fetchMock.mock.calls[0])).toBeNull();
  });

  it("returns undefined for 204 responses", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(client.apiFetchPublic("/auth/logout", { method: "POST" })).resolves.toBeUndefined();
  });
});
