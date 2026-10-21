/** Local production integration. No credentials in reports, traces, videos or screenshots. */
import { createRequire } from "node:module";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { kk } from "../src/locales/kk.ts";
import { im, fieldNames, importErrors } from "../src/locales/imports.kk.ts";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const base = process.env.SMOKE_BASE_URL || "http://127.0.0.1:8000";
if (
  !["http://127.0.0.1:8000", "http://localhost:8000"].includes(
    new URL(base).origin,
  )
)
  throw new Error("Only the local project origin is allowed");
const qa = resolve(root, ".local/qa");
const { accounts } = JSON.parse(
  await readFile(resolve(root, ".local/accounts.json"), "utf8"),
);
const checks = [];
const external = new Set();
let phase = "prepare";
let browser;
let assertion = "";
const ensure = (condition, code) => {
  if (!condition) {
    assertion = code;
    throw new Error(code);
  }
  checks.push({ check: code, passed: true });
};

async function signIn(page, role) {
  const account = accounts.find((account) => account.role === role);
  await page.goto(base);
  await page.getByLabel(kk.email, { exact: true }).fill(account.email);
  await page.getByLabel(kk.password, { exact: true }).fill(account.password);
  await page.getByRole("button", { name: kk.signIn, exact: true }).click();
  await page.getByRole("heading", { name: kk.overview, exact: true }).waitFor();
}
async function signOut(page) {
  await page.getByRole("button", { name: kk.signOut, exact: true }).click();
  await page
    .getByRole("heading", { name: kk.signInTitle, exact: true })
    .waitFor();
}
async function upload(page, filename) {
  await page
    .getByLabel(im.file, { exact: true })
    .setInputFiles(resolve(qa, filename));
  await page.getByLabel(im.year, { exact: true }).fill("2030-2031");
  await page.getByLabel(im.dataKind, { exact: true }).selectOption("synthetic");
  await page.getByLabel(im.unit, { exact: true }).selectOption("academic_hour");
  const response = page.waitForResponse(
    (response) =>
      response.url().endsWith("/imports/s1") &&
      response.request().method() === "POST" &&
      response.status() !== 403,
  );
  await page.getByRole("button", { name: im.makePreview, exact: true }).click();
  const result = await response;
  ensure(result.status() === 201, "preview_http_201");
  const batch = await result.json();
  await page.getByRole("heading", { name: `2. ${im.preview}` }).waitFor();
  return batch;
}
async function apply(page) {
  await page.getByLabel(im.confirmApply, { exact: true }).check();
  const response = page.waitForResponse(
    (response) =>
      response.url().endsWith("/apply") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: im.applyButton, exact: true }).click();
  const result = await response;
  ensure(result.status() === 200, "apply_http_200");
  await page
    .getByRole("status")
    .filter({ hasText: im.appliedNotice })
    .first()
    .waitFor();
  return result.json();
}
async function fit(page, width, code) {
  await page.setViewportSize({ width, height: 900 });
  ensure(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    code,
  );
}

try {
  await mkdir(qa, { recursive: true });
  execFileSync(
    resolve(root, ".venv/Scripts/python.exe"),
    ["-m", "backend.tests.make_browser_fixtures"],
    {
      cwd: root,
      stdio: "pipe",
      windowsHide: true,
      env: {
        ...process.env,
        SMART_JOBA_SMOKE_GROUP: `TEST-IMPORT-${randomUUID().slice(0, 8)}`,
      },
    },
  );
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {}),
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  context.on("request", (request) => {
    if (new URL(request.url()).origin !== new URL(base).origin)
      external.add(new URL(request.url()).origin);
  });
  const page = await context.newPage();
  phase = "scheduler_login";
  await signIn(page, "scheduler");
  await page.getByRole("button", { name: kk.import, exact: true }).click();
  await page.getByRole("heading", { name: im.title, exact: true }).waitFor();
  ensure(true, "scheduler_import_screen");
  phase = "invalid_upload";
  await page.getByLabel(im.file).setInputFiles({
    name: "broken.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from("not a workbook"),
  });
  await page.getByRole("button", { name: im.makePreview, exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: importErrors.IMPORT_ARCHIVE_INVALID })
    .waitFor();
  ensure(true, "invalid_workbook_explained");
  phase = "preview";
  const first = await upload(page, "synthetic-s1-demo.xlsx");
  ensure(first.summary.rows === 2, "agreed_range_ignores_stray_cell");
  ensure(
    first.rows[0].raw.room.value === 0 &&
      first.rows[0].normalized.room === null,
    "zero_room_preserved_and_unspecified",
  );
  ensure(
    first.rows[1].issues.some((issue) => issue.code === "FORMULA_NO_CACHE"),
    "formula_never_evaluated",
  );
  ensure(
    first.rows[1].issues.some((issue) => issue.code === "TEACHER_VACANCY"),
    "vacancy_remains_question",
  );
  phase = "row_review";
  await page
    .getByRole("button", { name: `${im.review} · 2`, exact: true })
    .click();
  await page.getByLabel(fieldNames.room, { exact: true }).fill("101");
  await page.getByLabel(im.wholeGroup, { exact: true }).check();
  await page.getByLabel(im.references, { exact: true }).check();
  const reviewResponse = page.waitForResponse((response) =>
    response.url().endsWith("/review"),
  );
  await page.getByRole("button", { name: im.save, exact: true }).click();
  ensure((await reviewResponse).status() === 200, "explicit_review_saved");
  await page.getByText(im.saved, { exact: true }).waitFor();
  phase = "apply_and_repeat";
  const applied = await apply(page);
  ensure(
    applied.summary.ready === 1 && applied.summary.open_issues > 0,
    "remaining_questions_visible_after_apply",
  );
  const repeated = await page.evaluate(async (id) => {
    const session = await (await fetch("/api/auth/session")).json();
    const response = await fetch(`/api/imports/${id}/apply`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": session.csrf_token,
      },
      body: JSON.stringify({ expected_revision: 1, confirmed: true }),
    });
    return response.status;
  }, first.id);
  ensure(repeated === 200, "repeated_apply_idempotent");
  const reuploaded = await upload(page, "synthetic-s1-demo.xlsx");
  ensure(
    reuploaded.summary.unchanged === 2 && reuploaded.summary.ready === 1,
    "reupload_preserves_confirmed_review_without_duplicates",
  );
  await apply(page);
  phase = "changed_file";
  const changed = await upload(page, "synthetic-s1-updated.xlsx");
  ensure(
    changed.summary.changed === 1 && changed.rows[0].previous.room === "101",
    "changes_shown_before_apply",
  );
  await page
    .getByRole("button", { name: `${im.review} · 2`, exact: true })
    .click();
  await page.getByLabel(im.wholeGroup, { exact: true }).check();
  await page.getByLabel(im.references, { exact: true }).check();
  const reviewed = page.waitForResponse((response) =>
    response.url().endsWith("/review"),
  );
  await page.getByRole("button", { name: im.save, exact: true }).click();
  ensure((await reviewed).status() === 200, "changed_source_review_confirmed");
  await apply(page);
  await page
    .getByRole("button", { name: `${im.review} · 2`, exact: true })
    .click();
  const history = await context.request.get(
    `${base}/api/imports/${changed.id}/rows/${changed.rows[0].id}/history`,
  );
  const revisions = await history.json();
  ensure(
    revisions.length >= 2 &&
      revisions[0].previous_revision_id === revisions[1].id,
    "history_links_old_and_new_sources",
  );
  await page.getByRole("button", { name: im.close, exact: true }).click();
  for (const width of [320, 360, 768, 1280])
    await fit(page, width, `import_viewport_${width}`);
  await page.locator("#preview-title").scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(qa, "stage2-import-1280.png") });
  await fit(page, 360, "mobile_import_navigation_fits");
  ensure(
    await page
      .getByRole("button", { name: kk.import, exact: true })
      .isVisible(),
    "mobile_import_navigation_accessible",
  );
  await page.locator("#preview-title").scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(qa, "stage2-import-360.png") });
  await signOut(page);
  phase = "admin_read_only";
  await signIn(page, "admin");
  await page.getByRole("button", { name: kk.import, exact: true }).click();
  await page.getByText(im.readOnly, { exact: true }).waitFor();
  ensure(
    (await page.getByLabel(im.file).count()) === 0 &&
      (await page
        .getByRole("button", { name: im.applyButton, exact: true })
        .count()) === 0,
    "admin_read_only_no_write_controls",
  );
  await signOut(page);
  phase = "student_access";
  await signIn(page, "student");
  ensure(
    (await page
      .getByRole("button", { name: kk.import, exact: true })
      .count()) === 0,
    "student_has_no_import_entry",
  );
  ensure(
    (
      await context.request.get(`${base}/api/imports/${first.id}/source`)
    ).status() === 403,
    "student_direct_source_download_denied",
  );
  ensure(
    await page.evaluate(
      () => localStorage.length === 0 && sessionStorage.length === 0,
    ),
    "no_persistent_browser_credentials",
  );
  await signOut(page);
  ensure(external.size === 0, "no_external_requests");
  await writeFile(
    resolve(qa, "stage2-browser-smoke.json"),
    JSON.stringify({ status: "passed", checks }, null, 2) + "\n",
  );
  process.stdout.write(
    JSON.stringify({ status: "passed", checks: checks.length }) + "\n",
  );
} catch (error) {
  let diagnostic = String(error?.stack || error);
  for (const account of accounts)
    diagnostic = diagnostic.replaceAll(account.password, "[REDACTED]");
  await writeFile(resolve(qa, "stage2-browser-error.log"), diagnostic);
  await writeFile(
    resolve(qa, "stage2-browser-smoke.json"),
    JSON.stringify({ status: "failed", phase, assertion, checks }, null, 2) +
      "\n",
  );
  process.stderr.write(
    JSON.stringify({ status: "failed", phase, assertion }) + "\n",
  );
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
}
