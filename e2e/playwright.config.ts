import { defineConfig } from "@playwright/test";

/**
 * End-to-end smoke test against a running installation: the production stack (docker-compose.prod.yml), reached
 * through its reverse proxy like a browser would. See e2e/README.md.
 *
 *   E2E_BASE_URL            where the application is (default https://localhost)
 *   E2E_ADMIN_EMAIL         the first administrator (SEED_ADMIN_EMAIL)
 *   E2E_ADMIN_PASSWORD      its initial password (SEED_ADMIN_PASSWORD)
 *   E2E_ADMIN_NEW_PASSWORD  the password the test gives it at the first login (and uses after that)
 */
export default defineConfig({
  testDir: "./tests",
  // One story told in order (the later steps need what the earlier ones made)
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "https://localhost",
    // The proxy's own certificate authority (internal network, CI) is not known to the browser
    ignoreHTTPSErrors: true,
    locale: "tr-TR",
    timezoneId: "Europe/Istanbul",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
