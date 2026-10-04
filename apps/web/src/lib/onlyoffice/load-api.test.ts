import { beforeEach, describe, expect, it, vi } from "vitest";

type LoadApi = typeof import("./load-api");

let loadOnlyOfficeApi: LoadApi["loadOnlyOfficeApi"];

function scripts(): HTMLScriptElement[] {
  return [...document.head.querySelectorAll("script")];
}

beforeEach(async () => {
  vi.resetModules(); // the loader remembers its pending load in module state
  document.head.replaceChildren();
  delete window.DocsAPI;
  ({ loadOnlyOfficeApi } = await import("./load-api"));
});

describe("loadOnlyOfficeApi", () => {
  it("adds the api.js script of the document server and resolves once DocsAPI exists", async () => {
    const loaded = loadOnlyOfficeApi();

    const [script] = scripts();
    expect(script.src).toBe("http://localhost:8080/web-apps/apps/api/documents/api.js");
    window.DocsAPI = { DocEditor: vi.fn() as never };
    script.dispatchEvent(new Event("load"));

    await expect(loaded).resolves.toBeUndefined();
  });

  it("loads the script only once for concurrent callers", async () => {
    const first = loadOnlyOfficeApi();
    const second = loadOnlyOfficeApi();

    expect(scripts()).toHaveLength(1);
    window.DocsAPI = { DocEditor: vi.fn() as never };
    scripts()[0].dispatchEvent(new Event("load"));
    await Promise.all([first, second]);
  });

  it("resolves without touching the page when the API is already there", async () => {
    window.DocsAPI = { DocEditor: vi.fn() as never };

    await expect(loadOnlyOfficeApi()).resolves.toBeUndefined();
    expect(scripts()).toHaveLength(0);
  });

  it("rejects when the script cannot be loaded, removes it and lets the next call retry", async () => {
    const failed = loadOnlyOfficeApi();
    scripts()[0].dispatchEvent(new Event("error"));
    await expect(failed).rejects.toThrow();
    expect(scripts()).toHaveLength(0);

    const retry = loadOnlyOfficeApi();
    expect(scripts()).toHaveLength(1);
    window.DocsAPI = { DocEditor: vi.fn() as never };
    scripts()[0].dispatchEvent(new Event("load"));
    await expect(retry).resolves.toBeUndefined();
  });

  it("rejects when the script loads but does not define DocsAPI", async () => {
    const loaded = loadOnlyOfficeApi();
    scripts()[0].dispatchEvent(new Event("load"));

    await expect(loaded).rejects.toThrow("DocsAPI");
  });
});
