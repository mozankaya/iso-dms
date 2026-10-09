import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";

/**
 * The smoke test: one document goes through its whole life the way people do it, in the browser, against the real
 * stack (no mocks): a new administrator picks a password, makes the people, an editor writes a document and sends it
 * to review, the unit approver and the quality manager approve it, and then it can be found, opened and downloaded.
 * The editor itself (ONLYOFFICE) is not needed: the pages that open it are kept from asking for it.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@example.com";
const ADMIN_INITIAL_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "";
const ADMIN_NEW_PASSWORD = process.env.E2E_ADMIN_NEW_PASSWORD ?? "E2e-Admin-Pass-2026";

const RUN = Date.now().toString(36);
const DOCUMENT_TITLE = `Uçtan Uca Deneme Prosedürü ${RUN}`;

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
  email: `${role.toLowerCase().replace("_", "-")}-${RUN}@e2e.test`,
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

async function apiLogin(request: APIRequestContext, email: string, password: string): Promise<string> {
  const response = await request.post("/api/auth/login", { data: { email, password } });
  expect(response.ok(), `login of ${email} answered ${response.status()}`).toBe(true);
  return (await response.json()).accessToken as string;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** A browser of its own for one person, so that each one has their own session. */
async function openAs(browser: Browser, who: Person | { email: string; password: string }): Promise<Page> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: "tr-TR", timezoneId: "Europe/Istanbul" });
  const page = await context.newPage();
  // Opening a document sends the browser to the editor, which would take the file for editing and lock it for review;
  // there is no editor here and none is needed (this is where the editor would be loaded)
  await page.route("**/api/editor/config/**", (route) => route.abort());
  await page.goto("/login");
  await page.getByLabel("E-posta").fill(who.email);
  await page.getByLabel("Şifre").fill("password" in who ? who.password : "");
  await page.getByRole("button", { name: "Giriş Yap" }).click();
  await expect(page.getByRole("heading", { name: "Ana Sayfa" })).toBeVisible();
  return page;
}

test.describe.configure({ mode: "serial" });

test("the application answers and its parts are up", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.status()).toBe(200);
  const health = await response.json();
  expect(health.checks).toMatchObject({ database: "up", storage: "up" });
});

test("the first administrator has to choose a password of their own before anything else", async ({ page, request }) => {
  // After an earlier run the initial password is gone: then this step has nothing left to show
  const probe = await request.post("/api/auth/login", { data: { email: ADMIN_EMAIL, password: ADMIN_INITIAL_PASSWORD } });
  test.skip(!probe.ok(), "the initial administrator password was changed by an earlier run");

  await page.goto("/login");
  await page.getByLabel("E-posta").fill(ADMIN_EMAIL);
  await page.getByLabel("Şifre").fill(ADMIN_INITIAL_PASSWORD);
  await page.getByRole("button", { name: "Giriş Yap" }).click();

  await expect(page.getByRole("heading", { name: "Şifre Değiştir" })).toBeVisible();
  await page.getByLabel("Mevcut şifre").fill(ADMIN_INITIAL_PASSWORD);
  await page.getByLabel("Yeni şifre", { exact: true }).fill(ADMIN_NEW_PASSWORD);
  await page.getByLabel("Yeni şifre (tekrar)").fill(ADMIN_NEW_PASSWORD);
  await page.getByRole("button", { name: "Şifreyi Değiştir" }).click();

  await expect(page.getByRole("heading", { name: "Ana Sayfa" })).toBeVisible();
});

test("the administrator makes an editor, an approver and a quality manager of the same unit", async ({ request }) => {
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

    // Everyone has to replace the temporary password once; done here so that the steps below start with a normal login
    const token = await apiLogin(request, who.email, who.temporaryPassword);
    const changed = await request.patch("/api/auth/password", {
      headers: bearer(token),
      data: { currentPassword: who.temporaryPassword, newPassword: who.password },
    });
    expect(changed.ok(), await changed.text()).toBe(true);
  }
});

test("the editor creates a document from the template and sends it to review", async ({ browser }) => {
  const page = await openAs(browser, people.editor);

  await page.goto("/categories/procedures");
  await page.getByRole("link", { name: "Yeni Doküman" }).click();
  await page.getByLabel("Doküman Adı").fill(DOCUMENT_TITLE);
  await page.getByRole("button", { name: "Doküman Oluştur" }).click();

  // A new document opens in the editor
  await page.waitForURL(/\/documents\/[0-9a-f-]{36}\/edit/);
  documentId = /\/documents\/([0-9a-f-]{36})\/edit/.exec(page.url())![1];

  await page.goto(`/documents/${documentId}`);
  await expect(page.getByRole("heading", { name: new RegExp(DOCUMENT_TITLE) })).toBeVisible();
  documentCode = (await page.getByText(/^[A-Z]{2,3}-[A-Z0-9]{2,4}-\d{3}$/).first().innerText()).trim();
  await expect(page.getByText("Taslak").first()).toBeVisible();

  await page.getByRole("button", { name: "Onaya Gönder" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Onaya gönder" }).click();

  await expect(page.getByRole("heading", { name: "Onay Süreci" })).toBeVisible();
  await expect(page.getByText("Onay bekliyor").first()).toBeVisible();
  await page.context().close();
});

async function decide(browser: Browser, who: Person) {
  const page = await openAs(browser, who);
  await page.goto("/approvals");
  const approve = page.getByRole("button", { name: new RegExp(`^Onayla \\(${documentCode} `) });
  await expect(approve).toBeVisible();
  await approve.click();
  await page.getByRole("dialog").getByRole("button", { name: "Onayla" }).click();
  // Decided: it is no longer waiting for this person
  await expect(approve).toBeHidden();
  await page.context().close();
}

test("the unit approver approves it, then the quality manager, and it goes into force", async ({ browser }) => {
  await decide(browser, people.approver);
  await decide(browser, people.quality);

  const page = await openAs(browser, people.editor);
  await page.goto(`/documents/${documentId}`);
  await expect(page.getByText("Yayında").first()).toBeVisible();
  await expect(page.getByText("Yürürlükte").first()).toBeVisible();
  await page.context().close();
});

test("a published document can be found by its words, opened from the result and downloaded", async ({ browser }) => {
  const page = await openAs(browser, people.editor);

  // The search is by the words of the title and ignores Turkish characters and capitals
  await page.getByRole("searchbox", { name: "Dokümanlarda ara" }).fill("UCTAN UCA prosedur");
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/search\?q=/);
  const result = page.getByRole("list", { name: "Arama sonuçları" }).getByRole("link", { name: documentCode });
  await expect(result).toBeVisible();

  await result.click();
  await expect(page.getByRole("heading", { name: new RegExp(DOCUMENT_TITLE) })).toBeVisible();

  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "İndir" }).first().click()]);
  expect(download.suggestedFilename()).toContain(documentCode);
  expect(download.suggestedFilename()).toMatch(/\.docx$/);
  await page.context().close();
});

test("what happened is in the audit trail", async ({ browser }) => {
  const page = await openAs(browser, { email: ADMIN_EMAIL, password: ADMIN_NEW_PASSWORD });

  await page.goto(`/admin/audit-logs?q=${encodeURIComponent(documentCode)}`);
  for (const action of ["Doküman oluşturuldu", "Onaya gönderildi", "Doküman yayınlandı"]) {
    // (the same words are also the options of the filter above the table)
    await expect(page.getByRole("table").getByText(action).first()).toBeVisible();
  }
  await page.context().close();
});

test.afterAll(async ({ request }) => {
  // The people of this run are taken out of use again (users are never deleted)
  if (!adminToken) return;
  for (const who of Object.values(people)) {
    if (who.id) await request.patch(`/api/users/${who.id}`, { headers: bearer(adminToken), data: { isActive: false } });
  }
});
