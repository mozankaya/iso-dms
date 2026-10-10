import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";

/**
 * The real editor, end to end (opt-in: E2E_REAL_EDITOR=1, needs the production stack with the real ONLYOFFICE, see
 * e2e/README.md). What the smoke test cannot show because it stands in for the document server: the editor opens
 * through the reverse proxy, text typed in it is saved to the revision (Ctrl+S, and when the editor is closed), the
 * saved file goes through the approval, and the published revision gets a PDF copy and can be found by the words
 * that were typed in the editor.
 */

const REAL_EDITOR = process.env.E2E_REAL_EDITOR === "1";
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@example.com";
const ADMIN_INITIAL_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "";
const ADMIN_NEW_PASSWORD = process.env.E2E_ADMIN_NEW_PASSWORD ?? "E2e-Admin-Pass-2026";

const RUN = Date.now().toString(36);
const TITLE = `Editör Deneme Prosedürü ${RUN}`;
// One word nobody else has, to find the document by what was typed in the editor
const TYPED_WORD = `editordenyazildi${RUN}`;

interface Person {
  role: "EDITOR" | "APPROVER" | "QUALITY_MANAGER";
  email: string;
  fullName: string;
  temporaryPassword: string;
  password: string;
  id?: string;
}
const person = (role: Person["role"], fullName: string): Person => ({
  role,
  fullName,
  email: `${role.toLowerCase().replace("_", "-")}-ed-${RUN}@e2e.test`,
  temporaryPassword: `E2e-Temp-${role}-${RUN}`,
  password: `E2e-Final-${role}-${RUN}`,
});
const people = {
  editor: person("EDITOR", "Ece Editör"),
  approver: person("APPROVER", "Onur Onaylayıcı"),
  quality: person("QUALITY_MANAGER", "Kader Kalite"),
};

let adminToken = "";
let documentId = "";
let documentCode = "";
let revisionId = "";

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function apiLogin(request: APIRequestContext, email: string, password: string): Promise<string> {
  const response = await request.post("/api/auth/login", { data: { email, password } });
  expect(response.ok(), `login of ${email} answered ${response.status()}`).toBe(true);
  return (await response.json()).accessToken as string;
}

async function openAs(browser: Browser, who: { email: string; password: string }): Promise<Page> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: "tr-TR", timezoneId: "Europe/Istanbul", viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel("E-posta").fill(who.email);
  await page.getByLabel("Şifre").fill(who.password);
  await page.getByRole("button", { name: "Giriş Yap" }).click();
  await expect(page.getByRole("heading", { name: "Ana Sayfa" })).toBeVisible();
  return page;
}

async function auditActions(request: APIRequestContext): Promise<string[]> {
  const response = await request.get(`/api/documents/${documentId}/audit-logs?pageSize=100`, { headers: bearer(adminToken) });
  expect(response.ok()).toBe(true);
  return ((await response.json()).items as { action: string }[]).map((entry) => entry.action);
}

test.describe.configure({ mode: "serial" });
test.skip(!REAL_EDITOR, "set E2E_REAL_EDITOR=1 (needs the stack with the real ONLYOFFICE)");
test.setTimeout(180_000);

test("the document server is up behind the proxy and the people exist", async ({ request }) => {
  const health = await (await request.get("/api/health")).json();
  expect(health.checks.editor).toBe("up");

  // The administrator may or may not have chosen a password yet (an earlier run)
  const first = await request.post("/api/auth/login", { data: { email: ADMIN_EMAIL, password: ADMIN_INITIAL_PASSWORD } });
  if (first.ok()) {
    const token = (await first.json()).accessToken as string;
    const changed = await request.patch("/api/auth/password", { headers: bearer(token), data: { currentPassword: ADMIN_INITIAL_PASSWORD, newPassword: ADMIN_NEW_PASSWORD } });
    expect(changed.ok(), await changed.text()).toBe(true);
  }
  adminToken = await apiLogin(request, ADMIN_EMAIL, ADMIN_NEW_PASSWORD);

  const departments = (await (await request.get("/api/departments", { headers: bearer(adminToken) })).json()) as { id: string; code: string }[];
  const unit = departments.find((department) => department.code === "KK") ?? departments[0];
  for (const who of Object.values(people)) {
    const created = await request.post("/api/users", {
      headers: bearer(adminToken),
      data: { fullName: who.fullName, email: who.email, role: who.role, departmentId: unit.id, password: who.temporaryPassword },
    });
    expect(created.status(), await created.text()).toBe(201);
    who.id = (await created.json()).user.id as string;
    const token = await apiLogin(request, who.email, who.temporaryPassword);
    const changed = await request.patch("/api/auth/password", { headers: bearer(token), data: { currentPassword: who.temporaryPassword, newPassword: who.password } });
    expect(changed.ok(), await changed.text()).toBe(true);
  }
});

test("a new document opens in the real editor, the typed text is saved with Ctrl+S", async ({ browser, request }) => {
  const page = await openAs(browser, people.editor);
  await page.goto("/categories/procedures");
  await page.getByRole("link", { name: "Yeni Doküman" }).click();
  await page.getByLabel("Doküman Adı").fill(TITLE);
  await page.getByRole("button", { name: "Doküman Oluştur" }).click();
  await page.waitForURL(/\/documents\/[0-9a-f-]{36}\/edit/);
  documentId = /\/documents\/([0-9a-f-]{36})\/edit/.exec(page.url())![1];

  // The editor is an iframe from the document server's own address
  const frame = page.frameLocator('iframe[name="frameEditor"]');
  await expect(page.locator('iframe[name="frameEditor"]')).toBeVisible({ timeout: 90_000 });
  await expect(frame.locator("#id_viewer_overlay")).toBeVisible({ timeout: 90_000 });
  // A tip about a new feature may cover a corner of the page
  const tip = frame.getByRole("button", { name: "Anladım" });
  if (await tip.isVisible().catch(() => false)) await tip.click();
  await page.screenshot({ path: "test-results/editor-open.png" });

  // Type into the document, below the header table
  await page.mouse.click(700, 500);
  await page.keyboard.type(`Merhaba ${TYPED_WORD} bu metin editörden yazıldı.`, { delay: 30 });
  await page.keyboard.press("Control+S");

  await expect.poll(async () => (await auditActions(request)).includes("REVISION_SAVED"), { timeout: 60_000, intervals: [2000] }).toBe(true);
  await page.screenshot({ path: "test-results/editor-typed.png" });

  // Closing the editor ends the session; the server then sends its closing save
  await page.goto(`/documents/${documentId}`);
  documentCode = (await page.getByText(/^[A-Z]{2,3}-[A-Z0-9]{2,4}-\d{3}$/).first().innerText()).trim();
  await page.context().close();
});

test("the draft goes through the approval after the editor is closed", async ({ browser }) => {
  const page = await openAs(browser, people.editor);
  await page.goto(`/documents/${documentId}`);
  await page.getByRole("button", { name: "Onaya Gönder" }).click();
  // The page waits for the closing save of the editor to arrive (up to 30 s) before it sends
  await page.getByRole("dialog").getByRole("button", { name: "Onaya gönder" }).click();
  await expect(page.getByRole("heading", { name: "Onay Süreci" })).toBeVisible({ timeout: 60_000 });
  await page.context().close();

  for (const who of [people.approver, people.quality]) {
    const decider = await openAs(browser, who);
    await decider.goto("/approvals");
    const approve = decider.getByRole("button", { name: new RegExp(`^Onayla \\(${documentCode} `) });
    await expect(approve).toBeVisible();
    await approve.click();
    await decider.getByRole("dialog").getByRole("button", { name: "Onayla" }).click();
    await expect(approve).toBeHidden();
    await decider.context().close();
  }
});

test("the published file has the typed text, a PDF copy is made, and the words find the document", async ({ request }) => {
  const editorToken = await apiLogin(request, people.editor.email, people.editor.password);
  const revisions = (await (await request.get(`/api/documents/${documentId}/revisions`, { headers: bearer(editorToken) })).json()) as { id: string; isCurrent: boolean; status: string }[];
  const current = revisions.find((revision) => revision.isCurrent);
  expect(current, JSON.stringify(revisions)).toBeTruthy();
  revisionId = current!.id;

  // The original file is the one the editor saved: it holds the typed word
  const original = await request.get(`/api/revisions/${revisionId}/download`, { headers: bearer(editorToken) });
  expect(original.ok()).toBe(true);
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(await original.body());
  expect(await zip.file("word/document.xml")!.async("string")).toContain(TYPED_WORD);

  // The PDF copy is made by the real converter after the publication
  await expect
    .poll(async () => ((await (await request.get(`/api/documents/${documentId}/revisions`, { headers: bearer(editorToken) })).json()) as { id: string; pdfStatus: string }[]).find((r) => r.id === revisionId)?.pdfStatus, {
      timeout: 120_000,
      intervals: [3000],
    })
    .toBe("READY");
  const pdf = await request.get(`/api/revisions/${revisionId}/download?format=pdf`, { headers: bearer(editorToken) });
  expect(pdf.ok()).toBe(true);
  const bytes = await pdf.body();
  expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  expect(bytes.length).toBeGreaterThan(1000);

  // And the words typed in the editor find the document
  await expect
    .poll(
      async () => {
        const found = await (await request.get(`/api/search?q=${TYPED_WORD}`, { headers: bearer(editorToken) })).json();
        return (found.items as { code: string; snippets: { text: string; match: boolean }[][] }[]).find((item) => item.code === documentCode)?.snippets.flat().some((part) => part.match) ?? false;
      },
      { timeout: 60_000, intervals: [2000] },
    )
    .toBe(true);
});

test("a revision started from the published one opens in the editor with the text in it", async ({ browser, request }) => {
  const page = await openAs(browser, people.editor);
  await page.goto(`/documents/${documentId}`);
  await page.getByRole("button", { name: "Revizyon Başlat" }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("Editör denemesi için ikinci sürüm");
  await page.getByRole("dialog").getByRole("button", { name: "Revizyonu başlat" }).click();
  await page.waitForURL(/\/documents\/[0-9a-f-]{36}\/edit/);

  const frame = page.frameLocator('iframe[name="frameEditor"]');
  await expect(frame.locator("#id_viewer_overlay")).toBeVisible({ timeout: 90_000 });
  await page.screenshot({ path: "test-results/editor-revision.png" });
  await page.context().close();
  const editorToken = await apiLogin(request, people.editor.email, people.editor.password);
  const revisions = (await (await request.get(`/api/documents/${documentId}/revisions`, { headers: bearer(editorToken) })).json()) as { revisionNo: number; status: string }[];
  expect(revisions.map((revision) => `${revision.revisionNo}:${revision.status}`)).toContain("1:DRAFT");
});

test.afterAll(async ({ request }) => {
  if (!adminToken) return;
  for (const who of Object.values(people)) {
    if (who.id) await request.patch(`/api/users/${who.id}`, { headers: bearer(adminToken), data: { isActive: false } });
  }
});
