/** Local, read-only UI regression. Uses prepared accounts through the normal login form.
 * Screenshots and the redacted report stay in ignored .local/qa; no trace or video.
 * Requires an existing Playwright installation and browser; never downloads either.
 */
import { createRequire } from "node:module";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { kk } from "../src/locales/kk.ts";
import { wb } from "../src/locales/workbench.kk.ts";
import { em } from "../src/locales/editor.kk.ts";
import { vm } from "../src/locales/publication.kk.ts";
import { pm } from "../src/locales/planning.kk.ts";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const base = process.env.SMOKE_BASE_URL || "http://127.0.0.1:8000";
const origin = new URL(base).origin;
if (!["127.0.0.1", "localhost"].includes(new URL(base).hostname))
  throw new Error("local_loopback_only");
const { accounts, scope_id: scope } = JSON.parse(
  await readFile(
    process.env.SMOKE_ACCOUNTS_FILE || resolve(root, ".local/accounts.json"),
    "utf8",
  ),
);
const dir = resolve(root, ".local/qa/agenda-weekly");
await mkdir(dir, { recursive: true });
const checks = [];
const consoleErrors = [];
const externalOrigins = new Set();
let phase = "launch",
  role = "public",
  browser,
  activePage;
function ensure(condition, code) {
  if (!condition) throw new Error(code);
}
function passed(check) {
  checks.push({ role, check, passed: true });
}
async function fits(page, label) {
  ensure(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    label,
  );
  passed(label);
}
async function settled(page, selector) {
  await page.locator(selector).waitFor();
  ensure((await page.getByRole("alert").count()) === 0, "unexpected_ui_alert");
}
async function capture(page, filename) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: resolve(dir, filename), fullPage: true });
}
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {}),
  });
  for (role of ["scheduler", "approver", "teacher", "student", "admin"]) {
    phase = "login";
    const account = accounts.find((a) => a.role === role);
    ensure(account, "prepared_account_missing");
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1024 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    activePage = page;
    page.setDefaultTimeout(15_000);
    const reads = [];
    page.on("pageerror", () => consoleErrors.push({ role, kind: "pageerror" }));
    page.on("console", (message) => {
      if (message.type() === "error")
        consoleErrors.push({ role, kind: "console" });
    });
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) {
        externalOrigins.add(url.origin);
        await route.abort();
      } else {
        if (url.pathname.startsWith("/api/")) reads.push(url.pathname);
        await route.continue();
      }
    });
    await page.goto(base);
    await page.getByLabel(kk.email, { exact: true }).fill(account.email);
    await page.getByLabel(kk.password, { exact: true }).fill(account.password);
    await page.getByRole("button", { name: kk.signIn, exact: true }).click();
    await page
      .getByRole("heading", { name: wb.overview, exact: true })
      .waitFor();
    await settled(page, ".home-agenda[aria-busy=false]");
    passed("normal_login_and_home");
    for (const width of [320, 360, 857, 1440]) {
      await page.setViewportSize({ width, height: width < 400 ? 800 : 1024 });
      await fits(page, `home_no_body_overflow_${width}`);
    }
    const workspaceResponse = await context.request.get(
      `${base}/api/scopes/${scope}/workspace`,
    );
    ensure(workspaceResponse.ok(), "workspace_unavailable");
    const workspace = await workspaceResponse.json();
    const canDraft = workspace.permissions.includes("draft.read");
    const canRead = workspace.permissions.some((p) =>
      p.startsWith("publication.read"),
    );
    if (!canDraft) {
      ensure(
        !reads.some((path) => path.endsWith("/schedule-versions")),
        "reader_requested_drafts",
      );
      ensure(
        (await page
          .getByRole("button", { name: wb.openDraft, exact: true })
          .count()) === 0,
        "reader_draft_action",
      );
      passed("no_draft_request_or_action_without_permission");
    }
    if (canRead) {
      phase = "published-week";
      const list = await (
        await context.request.get(`${base}/api/scopes/${scope}/publications`)
      ).json();
      const current = list.find((item) => item.is_current);
      ensure(current, "fixture_needs_current_publication");
      const published = await (
        await context.request.get(
          `${base}/api/publications/${current.publication_id}`,
        )
      ).json();
      ensure(published.events.length, "fixture_needs_visible_lesson");
      const date =
        published.events.find((event) => event.date === "2026-10-29")?.date ||
        published.events[0].date;
      await page.getByLabel(wb.date, { exact: true }).fill(date);
      await settled(page, ".home-agenda[aria-busy=false]");
      await page.locator(".agenda-lesson").first().waitFor();
      const group = published.resources.group[0];
      await page
        .getByLabel("Күннің тобы", { exact: true })
        .selectOption(group.id);
      await settled(page, ".home-agenda[aria-busy=false]");
      // Use all permitted groups for the visual comparison; no source records are changed.
      await page.getByLabel("Күннің тобы", { exact: true }).selectOption("");
      await settled(page, ".home-agenda[aria-busy=false]");
      if (role === "scheduler") {
        await capture(page, "home-desktop.png");
        await page.screenshot({
          path: resolve(dir, "home-desktop-viewport.png"),
        });
        await page.setViewportSize({ width: 360, height: 800 });
        await capture(page, "home-mobile.png");
        await page.setViewportSize({ width: 1440, height: 1024 });
      }
      await page
        .getByRole("button", { name: wb.openWeek, exact: true })
        .click();
      await settled(page, ".week-panel[aria-busy=false]");
      const lesson = page.locator(".week-lesson").first();
      await lesson.click();
      const inspector = page.getByRole("complementary", {
        name: wb.details,
        exact: true,
      });
      await inspector.getByText(wb.planned, { exact: true }).waitFor();
      ensure(
        (await inspector
          .getByRole("button", { name: wb.edit, exact: true })
          .count()) === 0,
        "publication_edit_exposed",
      );
      passed("home_date_to_week_and_readonly_inspector");
      if (role === "scheduler") {
        await capture(page, "week-desktop.png");
        await page.screenshot({
          path: resolve(dir, "week-desktop-viewport.png"),
        });
      }
      for (const width of [320, 360, 857, 1440]) {
        await page.setViewportSize({ width, height: width < 400 ? 800 : 1024 });
        await fits(page, `week_no_body_overflow_${width}`);
        if (role === "scheduler" && width === 360)
          await capture(page, "week-mobile.png");
      }
      await lesson.focus();
      await page.keyboard.press("Escape");
      await inspector.getByText(wb.selectLesson, { exact: true }).waitFor();
      ensure(
        await lesson.evaluate((node) => node === document.activeElement),
        "escape_focus_not_returned",
      );
      passed("keyboard_inspector_close_and_focus");
      await page
        .getByLabel("Аптаның ресурсы", { exact: true })
        .selectOption(group.id);
      await settled(page, ".week-panel[aria-busy=false]");
      await page.getByRole("button", { name: wb.list, exact: true }).click();
      phase = "publication-list-resource";
      await page.getByRole("table").waitFor();
      ensure(
        (await page.getByLabel(vm.resource).inputValue()) === group.id,
        "list_lost_week_resource",
      );
      await page.getByRole("button", { name: wb.week, exact: true }).click();
      phase = "publication-week-resource";
      await settled(page, ".week-panel[aria-busy=false]");
      ensure(
        (await page
          .getByLabel("Аптаның ресурсы", { exact: true })
          .inputValue()) === group.id,
        "week_lost_list_resource",
      );
      for (const type of ["teacher", "room", "group"]) {
        await page
          .getByLabel("Кесте көрінісі", { exact: true })
          .selectOption(type);
        await settled(page, ".week-panel[aria-busy=false]");
      }
      passed("week_list_resource_filters");
      await page
        .getByRole("button", { name: wb.nextWeek, exact: true })
        .click();
      await settled(page, ".week-panel[aria-busy=false]");
      await page
        .getByRole("button", { name: wb.previousWeek, exact: true })
        .click();
      await settled(page, ".week-panel[aria-busy=false]");
      await page.getByRole("button", { name: wb.today, exact: true }).click();
      await settled(page, ".week-panel[aria-busy=false]");
      passed("previous_next_today_navigation");
    }
    if (canDraft) {
      phase = "draft-inspector";
      await page
        .locator(".sidebar")
        .getByRole("link", { name: kk.overview, exact: true })
        .click();
      await settled(page, ".home-agenda[aria-busy=false]");
      await page
        .getByRole("button", { name: wb.openDraft, exact: true })
        .click();
      await settled(page, ".week-panel[aria-busy=false]");
      const data = await (
        await context.request.get(`${base}/api/scopes/${scope}/editor-data`)
      ).json();
      const draftId = data.drafts.find((d) => d.status === "draft")?.id;
      ensure(draftId, "fixture_needs_draft");
      const draft = await (
        await context.request.get(`${base}/api/drafts/${draftId}`)
      ).json();
      ensure(draft.occurrences.length, "fixture_needs_draft_lesson");
      await page
        .getByLabel(wb.date, { exact: true })
        .fill(draft.occurrences[0].date);
      await settled(page, ".week-panel[aria-busy=false]");
      await page.locator(".week-lesson").first().click();
      if (workspace.permissions.includes("draft.edit")) {
        if (role === "scheduler") {
          await capture(page, "draft-week-desktop.png");
          await page.screenshot({
            path: resolve(dir, "draft-week-desktop-viewport.png"),
          });
        }
        await page.getByRole("button", { name: wb.edit, exact: true }).click();
        await page
          .getByRole("button", { name: em.saveOne, exact: true })
          .waitFor();
        ensure(
          await page.getByLabel(wb.date, { exact: true }).isDisabled(),
          "open_form_allows_week_change",
        );
        ensure(
          await page
            .getByRole("button", { name: wb.list, exact: true })
            .isDisabled(),
          "open_form_allows_list_change",
        );
        if (role === "scheduler")
          await capture(page, "draft-inspector-desktop.png");
        await page
          .locator(".lesson-inspector form")
          .getByRole("button", { name: em.close, exact: true })
          .click();
        passed("existing_draft_form_opens_without_mutation");
      } else {
        ensure(
          (await page
            .getByRole("button", { name: wb.edit, exact: true })
            .count()) === 0,
          "approver_can_edit",
        );
        passed("approver_draft_is_readonly");
      }
    } else if (["teacher", "student"].includes(role)) {
      const denied = await context.request.get(
        `${base}/api/scopes/${scope}/editor-data`,
      );
      ensure(denied.status() === 403, "server_draft_access_not_denied");
      passed("server_denies_reader_draft_access");
    }
    if (role === "scheduler") {
      phase = "existing-modules";
      for (const [label, selector, name] of [
        [kk.import, ".import-page", "import"],
        [kk.calendar, ".calendar-page", "calendar"],
        [pm.title, ".planning-page", "planning"],
        [kk.publication, ".version-page", "versions"],
      ]) {
        await page
          .locator(".sidebar")
          .getByRole("button", { name: label, exact: true })
          .click();
        await page.locator(selector).waitFor();
        // These screens load their own data; wait for their first API request to settle.
        await page.waitForLoadState("networkidle");
        ensure(
          (await page.getByRole("alert").count()) === 0,
          `existing_${name}_alert`,
        );
        for (const width of [360, 1440]) {
          await page.setViewportSize({
            width,
            height: width === 360 ? 800 : 1024,
          });
          await fits(page, `existing_${name}_no_overflow_${width}`);
        }
        passed(`existing_${name}_navigation`);
      }
    }
    phase = "logout";
    await page.getByRole("button", { name: kk.signOut, exact: true }).click();
    await page.getByRole("button", { name: kk.signIn, exact: true }).waitFor();
    passed("logout");
    await context.close();
  }
  ensure(consoleErrors.length === 0, "browser_console_error");
  ensure(externalOrigins.size === 0, "runtime_external_request");
  console.log(
    JSON.stringify({
      passed: true,
      checks: checks.length,
      roles: 5,
      externalOrigins: 0,
      consoleErrors: 0,
    }),
  );
} catch (error) {
  if (activePage && phase !== "login")
    await writeFile(
      resolve(dir, "failure.txt"),
      await activePage.locator("body").innerText(),
      "utf8",
    );
  console.log(
    JSON.stringify({
      passed: false,
      phase,
      role,
      reason: error.message.split("\n")[0],
    }),
  );
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  await writeFile(
    resolve(dir, "browser-report.json"),
    JSON.stringify(
      {
        checks,
        phase,
        role,
        passed: !process.exitCode,
        consoleErrors,
        externalOrigins: [...externalOrigins],
      },
      null,
      2,
    ),
  );
}
