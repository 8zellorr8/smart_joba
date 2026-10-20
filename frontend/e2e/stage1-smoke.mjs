/**
 * Real browser smoke against an already running local API + production frontend.
 * Credentials stay in memory. No trace, video or authenticated screenshot is made.
 * Uses an existing Playwright installation; never downloads a browser.
 */
import { createRequire } from "node:module";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { kk } from "../src/locales/kk.ts";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const base = process.env.SMOKE_BASE_URL || "http://127.0.0.1:8000";
const origin = new URL(base).origin;
if (!["127.0.0.1", "localhost"].includes(new URL(base).hostname)) {
  throw new Error(
    "Only a loopback server is allowed for the local credential smoke.",
  );
}
const accountFile =
  process.env.SMOKE_ACCOUNTS_FILE || resolve(root, ".local/accounts.json");
const qaDir = resolve(root, ".local/qa");
const { scope_id: scopeId, accounts } = JSON.parse(
  await readFile(accountFile, "utf8"),
);
const checks = [];
const externalOrigins = new Set();
let phase = "launch";
let failure = "";
let browser;

function ensure(condition, safeCode) {
  if (!condition) {
    failure = safeCode;
    throw new Error(safeCode);
  }
}
function passed(name, role) {
  checks.push({ check: name, ...(role ? { role } : {}), passed: true });
}
const roleNames = {
  admin: kk.roleAdmin,
  scheduler: kk.roleScheduler,
  approver: kk.roleApprover,
  teacher: kk.roleTeacher,
  student: kk.roleStudent,
};

async function assertNoHorizontalOverflow(page, name) {
  const fits = await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth + 1,
  );
  ensure(fits, name);
}

try {
  await mkdir(qaDir, { recursive: true });
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {}),
  });

  phase = "public-and-invalid-login";
  const publicContext = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const page = await publicContext.newPage();
  page.setDefaultTimeout(15_000);
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      externalOrigins.add(url.origin);
      await route.abort();
    } else await route.continue();
  });
  const unauth = await publicContext.request.get(
    `${base}/api/scopes/${encodeURIComponent(scopeId)}/workspace`,
  );
  ensure(unauth.status() === 401, "unauthenticated_workspace_must_be_401");
  passed("unauthenticated_workspace_401");
  await page.goto(base);
  await page.getByRole("button", { name: kk.signIn, exact: true }).waitFor();
  ensure(
    (await page.locator("html").getAttribute("lang")) === "kk",
    "html_language_must_be_kk",
  );
  passed("html_language_kk");
  for (const width of [320, 360, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await assertNoHorizontalOverflow(page, `login_overflow_${width}`);
    passed(`login_viewport_${width}`);
    // The form is still empty here: screenshots contain no credential data.
    if (width === 360 || width === 1280)
      await page.screenshot({
        path: resolve(qaDir, `login-${width}.png`),
        fullPage: true,
      });
  }
  await page.setViewportSize({ width: 360, height: 900 });
  await page
    .getByLabel(kk.email, { exact: true })
    .fill("wrong-account@example.test");
  await page
    .getByLabel(kk.password, { exact: true })
    .fill("invalid-smoke-value");
  await page.getByRole("button", { name: kk.signIn, exact: true }).click();
  await page.getByText(kk.invalidCredentials, { exact: true }).waitFor();
  ensure(
    (await page.getByLabel(kk.password, { exact: true }).inputValue()) === "",
    "invalid_login_password_not_cleared",
  );
  ensure(
    (await page.getByLabel(kk.email, { exact: true }).inputValue()) ===
      "wrong-account@example.test",
    "invalid_login_email_not_preserved",
  );
  passed("invalid_login_clears_password_preserves_email");
  await publicContext.close();

  ensure(
    Array.isArray(accounts) && accounts.length === 5,
    "expected_five_prepared_accounts",
  );
  for (const account of accounts) {
    phase = `account-${account.role}`;
    ensure(Object.hasOwn(roleNames, account.role), "unexpected_prepared_role");
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    const current = await context.newPage();
    current.setDefaultTimeout(15_000);
    await current.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) {
        externalOrigins.add(url.origin);
        await route.abort();
      } else await route.continue();
    });
    await current.goto(base);
    await current.getByLabel(kk.email, { exact: true }).fill(account.email);
    await current
      .getByLabel(kk.password, { exact: true })
      .fill(account.password);
    await current.getByRole("button", { name: kk.signIn, exact: true }).click();
    await current.getByText(roleNames[account.role], { exact: true }).waitFor();
    const sessionResponse = await context.request.get(
      `${base}/api/auth/session`,
    );
    const session = await sessionResponse.json();
    ensure(
      sessionResponse.status() === 200 &&
        session.user?.grants?.some((grant) => grant.role === account.role),
      "server_role_does_not_match_prepared_account",
    );
    passed("login_server_role", account.role);
    await current.reload();
    await current.getByText(roleNames[account.role], { exact: true }).waitFor();
    passed("reload_restores_session", account.role);
    for (const width of [320, 360, 768, 1280]) {
      await current.setViewportSize({ width, height: 900 });
      await assertNoHorizontalOverflow(current, `workspace_overflow_${width}`);
      passed(`workspace_viewport_${width}`, account.role);
    }
    const noPersistentSecrets = await current.evaluate(
      () =>
        localStorage.length === 0 &&
        sessionStorage.length === 0 &&
        location.search === "" &&
        location.hash === "",
    );
    ensure(noPersistentSecrets, "unexpected_persistent_browser_state");
    passed("no_persistent_browser_state", account.role);
    await current
      .getByRole("button", { name: kk.signOut, exact: true })
      .click();
    await current
      .getByRole("button", { name: kk.signIn, exact: true })
      .waitFor();
    const revoked = await context.request.get(
      `${base}/api/scopes/${encodeURIComponent(scopeId)}/workspace`,
    );
    ensure(revoked.status() === 401, "logout_did_not_revoke_server_session");
    passed("logout_revokes_server_session", account.role);
    await context.close();
  }
  ensure(externalOrigins.size === 0, "unexpected_external_browser_request");
  passed("no_external_browser_requests");
  await writeFile(
    resolve(qaDir, "stage1-browser-smoke.json"),
    JSON.stringify(
      {
        status: "passed",
        checks,
        external_request_count: externalOrigins.size,
      },
      null,
      2,
    ),
  );
  console.log(
    `Browser smoke passed: ${checks.length} checks, all five roles, no external requests.`,
  );
} catch {
  // Do not print the raw Playwright error: locator call logs can include fill values.
  const safeFailure = {
    status: "failed",
    phase,
    failure: failure || "browser_step_failed",
    checks,
    external_request_count: externalOrigins.size,
  };
  await mkdir(qaDir, { recursive: true });
  await writeFile(
    resolve(qaDir, "stage1-browser-smoke.json"),
    JSON.stringify(safeFailure, null, 2),
  );
  console.error(
    `Browser smoke failed in ${phase}; code: ${safeFailure.failure}. See .local/qa/stage1-browser-smoke.json.`,
  );
  process.exitCode = 1;
} finally {
  await browser?.close();
}
