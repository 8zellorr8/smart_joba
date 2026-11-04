/** Local synthetic data only. Reads live API; faults below are explicitly injected. */
import { createRequire } from "node:module";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { kk } from "../src/locales/kk.ts";
import { wb } from "../src/locales/workbench.kk.ts";
import { jm } from "../src/locales/journal.kk.ts";
import { sm } from "../src/locales/student.kk.ts";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { accounts, scope_id: scope } = JSON.parse(
  await readFile(resolve(root, ".local/accounts.json"), "utf8"),
);
const base = "http://127.0.0.1:8000",
  endpoint = `${base}/api/scopes/${scope}/journal`,
  dir = resolve(root, ".local/qa/student-results");
const checks = [],
  errors = [],
  external = [];
let browser,
  activePage,
  phase = "launch";
function check(value, name) {
  if (!value) throw new Error(name);
  checks.push(name);
}
async function login(role) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1024 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  activePage = page;
  page.setDefaultTimeout(15000);
  page.on("pageerror", () => errors.push(`${role}:pageerror`));
  await page.route("**/*", async (route) => {
    if (new URL(route.request().url()).origin !== base) {
      external.push("external");
      return route.abort();
    }
    return route.continue();
  });
  await page.goto(base);
  const a = accounts.find((a) => a.role === role);
  await page.getByLabel(kk.email, { exact: true }).fill(a.email);
  await page.getByLabel(kk.password, { exact: true }).fill(a.password);
  await page.getByRole("button", { name: kk.signIn, exact: true }).click();
  await page.getByRole("heading", { name: wb.overview, exact: true }).waitFor();
  return { context, page };
}
async function open(page) {
  await page.getByRole("button", { name: jm.profile, exact: true }).click();
  await page.getByRole("heading", { name: sm.title, exact: true }).waitFor();
  await page.locator(".student-result").first().waitFor();
}
try {
  await mkdir(dir, { recursive: true });
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  });
  const s = await login("student");
  phase = "own results";
  const raw = await s.context.request.get(endpoint + "/me/results");
  check(raw.status() === 200, "personal_read_200");
  const own = await raw.json();
  check(
    own.student.data_kind === "synthetic" && own.items.length > 0,
    "synthetic_saved_records",
  );
  await open(s.page);
  check(
    (await s.page.locator(".student-result").count()) === own.items.length,
    "live_records_match_server",
  );
  const first = own.items[0];
  check(
    (await s.page.locator(".student-result").first().innerText()).includes(
      first.topic,
    ),
    "topic_from_saved_fact",
  );
  check(
    (await s.page.locator(".student-result-values dd").first().innerText()) ===
      (first.grade === null ? sm.noGrade : String(first.grade)),
    "grade_exact_including_zero_or_null",
  );
  check(
    (await s.page.locator(".student-result input").count()) === 0,
    "results_read_only",
  );
  check(
    !("average" in own) && !("history" in own) && !("students" in own),
    "no_totals_or_staff_history",
  );
  const period = own.periods[0],
    subject = own.subjects[0];
  await s.page
    .getByLabel(sm.period, { exact: true })
    .selectOption(`${period.context_id}:${period.semester}`);
  await s.page.locator(".student-result").first().waitFor();
  await s.page.getByLabel(sm.subject, { exact: true }).selectOption(subject.id);
  await s.page.locator(".student-result").first().waitFor();
  check(
    (await s.page.getByLabel(sm.subject, { exact: true }).inputValue()) ===
      subject.id,
    "selected_subject_kept",
  );
  for (const width of [320, 360, 857, 1440]) {
    await s.page.setViewportSize({ width, height: width < 600 ? 800 : 1024 });
    check(
      await s.page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      `no_page_overflow_${width}`,
    );
    check(
      await s.page.locator(".student-result-values").first().isVisible(),
      `grade_visible_${width}`,
    );
    await s.page.screenshot({
      path: resolve(dir, `student-${width}.png`),
      fullPage: true,
    });
  }
  await s.page.setViewportSize({ width: 360, height: 800 });
  const filter = s.page.getByLabel(sm.subject, { exact: true });
  await filter.focus();
  check(
    await filter.evaluate(
      (el) =>
        el === document.activeElement &&
        getComputedStyle(el).outlineStyle !== "none",
    ),
    "keyboard_visible_focus",
  );
  phase = "network and stale states";
  await s.page.route("**/journal/me/results?*", (route) => route.abort(), {
    times: 1,
  });
  await s.page.getByRole("button", { name: sm.refresh, exact: true }).click();
  await s.page.getByText(jm.loadError, { exact: true }).waitFor();
  check(
    (await s.page.locator(".student-result").count()) === 0,
    "network_failure_clears_rows",
  );
  check(
    (await s.page.getByText(sm.empty, { exact: true }).count()) === 0,
    "network_failure_not_empty_success",
  );
  check(
    (await filter.inputValue()) === subject.id,
    "network_failure_keeps_filters",
  );
  await s.page.getByRole("button", { name: jm.retry, exact: true }).click();
  await s.page.locator(".student-result").first().waitFor();
  check(true, "network_retry_recovers_live_results");
  await s.page.route(
    "**/journal/me/results?*",
    (route) =>
      route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "JOURNAL_RESULTS_STALE" } }),
      }),
    { times: 1 },
  );
  await s.page.getByRole("button", { name: sm.refresh, exact: true }).click();
  await s.page.getByText(sm.stale, { exact: true }).waitFor();
  check(
    (await s.page.locator(".student-result").count()) === 0,
    "stale_does_not_display_old_rows",
  );
  await s.page.getByRole("button", { name: sm.reload, exact: true }).click();
  await s.page.locator(".student-result").first().waitFor();
  check(
    (await filter.inputValue()) === subject.id,
    "stale_reload_retains_filters",
  );
  phase = "schedule navigation";
  await s.page.getByRole("button", { name: sm.schedule, exact: true }).click();
  await s.page.getByRole("heading", { name: wb.weekly, exact: true }).waitFor();
  check(true, "opens_existing_permitted_weekly_schedule");
  await open(s.page);
  await s.page.reload();
  await s.page
    .getByRole("heading", { name: wb.overview, exact: true })
    .waitFor();
  await open(s.page);
  check(
    (await s.page.locator(".student-result").count()) === own.items.length,
    "saved_results_after_reload",
  );
  check(
    (
      await s.context.request.get(
        endpoint +
          "/me/results?student_id=00000000-0000-0000-0000-000000000001",
      )
    ).status() === 422,
    "caller_cannot_select_student",
  );
  check(
    (
      await s.context.request.get(endpoint + `/lessons/${first.id}/history`)
    ).status() === 403,
    "student_cannot_read_service_history",
  );
  for (const role of ["teacher", "admin", "scheduler", "approver"]) {
    phase = role;
    const r = await login(role);
    check(
      (await r.context.request.get(endpoint + "/me/results")).status() === 403,
      `${role}_cannot_use_personal_endpoint`,
    );
    check(
      (await r.page
        .getByRole("button", { name: jm.profile, exact: true })
        .count()) === 0,
      `${role}_no_student_navigation`,
    );
    if (role === "teacher") {
      const saved = await (
        await r.context.request.get(endpoint + `/lessons/${first.id}`)
      ).json();
      const mine = saved.students.find((x) => x.student_id === own.student.id);
      check(
        mine &&
          mine.grade === first.grade &&
          mine.attendance === first.attendance,
        "personal_values_match_teacher_record",
      );
      check(
        saved.students
          .filter((x) => x.student_id !== own.student.id)
          .every(
            (peer) =>
              !JSON.stringify(own).includes(peer.student_id) &&
              !JSON.stringify(own).includes(peer.display_name),
          ),
        "peer_names_ids_absent_from_entire_response",
      );
    }
    await r.context.close();
  }
  phase = "revoked read UI";
  await s.page.route(
    "**/journal/me/results?*",
    (route) =>
      route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "ACCESS_DENIED" } }),
      }),
    { times: 1 },
  );
  await s.page.getByRole("button", { name: sm.refresh, exact: true }).click();
  await s.page.getByText(jm.denied, { exact: true }).waitFor();
  check(
    (await s.page.locator(".student-result").count()) === 0 &&
      (await s.page.locator(".student-results-identity").count()) === 0,
    "denial_clears_rows_and_identity",
  );
  check(
    (await s.page.getByLabel(sm.subject, { exact: true }).count()) === 0,
    "denial_clears_subject_metadata",
  );
  await s.context.close();
  check(errors.length === 0, "no_page_errors");
  check(external.length === 0, "no_external_requests");
  await writeFile(
    resolve(dir, "browser-report.json"),
    JSON.stringify(
      {
        checks,
        errors,
        external,
        roles: 5,
        injected: ["network failure", "409 stale", "403 denial"],
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ passed: checks.length, roles: 5, errors, external }),
  );
} catch (e) {
  await activePage
    ?.screenshot({ path: resolve(dir, "failure.png"), fullPage: true })
    .catch(() => {});
  await writeFile(
    resolve(dir, "failure.json"),
    JSON.stringify(
      { phase, message: e.message, checks, errors, external },
      null,
      2,
    ),
  );
  console.error(
    `Student results browser acceptance failed in ${phase}: ${e.message}`,
  );
  process.exitCode = 1;
} finally {
  await browser?.close();
}
