/** Loopback-only journal setup smoke. Adds explicitly synthetic demo students
 * through normal admin forms; never changes imported college source records.
 * Credentials, screenshots and reports remain in ignored .local.
 */
import { createRequire } from "node:module";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { kk } from "../src/locales/kk.ts";
import { wb } from "../src/locales/workbench.kk.ts";
import { portal } from "../src/locales/portal.kk.ts";
import { jm } from "../src/locales/journal.kk.ts";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const base = "http://127.0.0.1:8000";
const { accounts, scope_id: scope } = JSON.parse(
  await readFile(resolve(root, ".local/accounts.json"), "utf8"),
);
const dir = resolve(root, ".local/qa/journal-foundation");
await mkdir(dir, { recursive: true });
const checks = [];
const errors = [];
const external = [];
let browser,
  phase = "launch",
  activePage;
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
  page.on("pageerror", () => errors.push(role + ":pageerror"));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(role + ":console");
  });
  await page.route("**/*", async (route) => {
    if (new URL(route.request().url()).origin !== base) {
      external.push("external_request");
      await route.abort();
    } else await route.continue();
  });
  await page.goto(base);
  const account = accounts.find((a) => a.role === role);
  await page.getByLabel(kk.email, { exact: true }).fill(account.email);
  await page.getByLabel(kk.password, { exact: true }).fill(account.password);
  await page.getByRole("button", { name: kk.signIn, exact: true }).click();
  await page.getByRole("heading", { name: wb.overview, exact: true }).waitFor();
  return { context, page };
}
const endpoint = `${base}/api/scopes/${scope}/journal`;
async function data(context) {
  const r = await context.request.get(endpoint + "/setup");
  if (!r.ok()) throw new Error("setup_not_readable");
  return r.json();
}
async function save(page) {
  const response = page.waitForResponse(
    (r) =>
      r.url() === endpoint + "/commands" && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: jm.save, exact: true }).click();
  const result = await response;
  check(result.ok(), "admin_command_saved");
  await page.getByText(jm.saved, { exact: true }).waitFor();
  await page.waitForLoadState("networkidle");
}
async function tab(page, label) {
  await page
    .locator(".journal-tabs")
    .getByRole("button", { name: label, exact: true })
    .click();
}
async function evidence(page) {
  await page
    .getByLabel(jm.source, { exact: true })
    .fill("Синтетикалық демонстрациялық мысал; колледж деректері емес");
  await page.getByLabel(jm.confirmed, { exact: true }).check();
}
async function fits(page, role) {
  for (const width of [320, 360, 857, 1440]) {
    await page.setViewportSize({ width, height: width < 400 ? 800 : 1024 });
    check(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      role + "_no_overflow_" + width,
    );
  }
}
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  });
  phase = "admin-setup";
  const { page, context } = await login("admin");
  await page
    .getByRole("button", { name: portal.sections, exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: jm.setup, exact: true })
    .click();
  await page.getByLabel(jm.name, { exact: true }).waitFor();
  let d = await data(context);
  const group = d.groups.find(
    (g) => g.code === "TEST-EDITOR-A" && g.data_kind === "synthetic",
  );
  const demand = d.demands.find(
    (x) => x.group_id === group?.id && x.subject === "SYNTHETIC Subject 0",
  );
  const teacher = d.teachers.find(
    (t) =>
      t.display_name === "SYNTHETIC Editor Teacher A" &&
      t.data_kind === "synthetic",
  );
  check(Boolean(demand && teacher), "existing_synthetic_catalog_available");
  for (const name of ["Демо студент А", "Демо студент Б", "Демо студент В"]) {
    if (
      !d.students.some(
        (s) => s.display_name === name && s.data_kind === "synthetic",
      )
    ) {
      await page.getByLabel(jm.name, { exact: true }).fill(name);
      await page.getByLabel(jm.kind, { exact: true }).selectOption("synthetic");
      await save(page);
      d = await data(context);
    }
  }
  check(
    d.students.filter((s) => s.data_kind === "synthetic").length >= 3,
    "synthetic_students_created",
  );
  await fits(page, "students");
  await page.screenshot({
    path: resolve(dir, "students-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 360, height: 800 });
  await page.screenshot({
    path: resolve(dir, "students-mobile.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1024 });
  phase = "memberships";
  await tab(page, jm.memberships);
  const students = ["Демо студент А", "Демо студент Б", "Демо студент В"].map(
    (name) =>
      d.students.find(
        (s) => s.display_name === name && s.data_kind === "synthetic",
      ),
  );
  for (const student of students) {
    if (
      !d.memberships.some(
        (m) =>
          m.student_id === student.id && m.context_id === demand.context_id,
      )
    ) {
      await page
        .getByLabel(jm.student, { exact: true })
        .selectOption(student.id);
      await page
        .getByLabel(jm.context, { exact: true })
        .selectOption(demand.context_id);
      await page.getByLabel(jm.group, { exact: true }).selectOption(group.id);
      await page.getByLabel(jm.start, { exact: true }).fill("2026-09-01");
      await page.getByLabel(jm.end, { exact: true }).fill("2027-07-01");
      await evidence(page);
      await save(page);
      d = await data(context);
    }
  }
  await fits(page, "memberships");
  phase = "binding";
  await tab(page, jm.bindings);
  const account = d.accounts.find(
    (a) => a.email === accounts.find((a) => a.role === "student").email,
  );
  check(Boolean(account), "prepared_student_account_retained");
  const existingBinding = d.bindings.find((b) => b.user_id === account.id);
  if (!existingBinding?.student_id) {
    await page.getByLabel(jm.account, { exact: true }).selectOption(account.id);
    await page
      .getByLabel(jm.student, { exact: true })
      .selectOption(students[0].id);
    if (existingBinding)
      await page
        .getByLabel(jm.reason, { exact: true })
        .fill("Синтетикалық оқу профилін растау");
    await evidence(page);
    await save(page);
    d = await data(context);
  } else
    check(
      existingBinding.student_id === students[0].id,
      "preexisting_binding_must_not_be_overwritten",
    );
  phase = "journal-and-assignment";
  await tab(page, jm.journals);
  let journal = d.journals.find(
    (j) =>
      j.group === group.code &&
      j.subject === demand.subject &&
      j.data_kind === "synthetic",
  );
  if (!journal) {
    await page.getByLabel(jm.demand, { exact: true }).selectOption(demand.id);
    await evidence(page);
    await save(page);
    d = await data(context);
    journal = d.journals.find(
      (j) =>
        j.group === group.code &&
        j.subject === demand.subject &&
        j.data_kind === "synthetic",
    );
  }
  check(Boolean(journal), "journal_created_from_confirmed_ids");
  if (
    !d.assignments.some(
      (a) =>
        a.journal_id === journal.id && a.teacher_id === teacher.id && a.active,
    )
  ) {
    await page
      .locator(".journal-catalog article")
      .filter({ hasText: "Ағылшын тілі" })
      .getByRole("button", { name: jm.addAssignment, exact: true })
      .click();
    await page.getByLabel(jm.teacher, { exact: true }).selectOption(teacher.id);
    await page.getByLabel(jm.start, { exact: true }).fill("2026-09-01");
    await page.getByLabel(jm.end, { exact: true }).fill("2027-07-01");
    await evidence(page);
    await save(page);
  }
  await fits(page, "assignments");
  await page.screenshot({
    path: resolve(dir, "assignments-desktop.png"),
    fullPage: true,
  });
  check(
    (await context.request.get(endpoint + "/journals")).status() === 403,
    "admin_has_no_journal_read_bypass",
  );
  await context.close();
  for (const role of ["teacher", "approver", "student", "scheduler"]) {
    phase = role;
    const { context, page } = await login(role);
    check(
      (await context.request.get(endpoint + "/setup")).status() === 403,
      role + "_server_denies_setup",
    );
    if (["teacher", "approver"].includes(role)) {
      await page
        .locator(".portal-primary-nav")
        .getByRole("button", { name: jm.title, exact: true })
        .click();
      await page
        .getByRole("button", { name: jm.openRoster, exact: true })
        .click();
      await page.getByLabel(jm.date, { exact: true }).fill("2026-10-29");
      await page.getByRole("button", { name: jm.show, exact: true }).click();
      await page
        .locator(".journal-roster")
        .getByText("Демо студент А", { exact: true })
        .waitFor();
      check(
        (await page.locator(".journal-roster li").count()) === 3,
        role + "_confirmed_date_roster",
      );
      check(
        (await page
          .getByRole("button", { name: jm.save, exact: true })
          .count()) === 0,
        role + "_preview_has_no_fact_write",
      );
      await fits(page, role);
      if (role === "teacher") {
        await page.screenshot({
          path: resolve(dir, "teacher-desktop.png"),
          fullPage: true,
        });
        await page.setViewportSize({ width: 360, height: 800 });
        await page.screenshot({
          path: resolve(dir, "teacher-mobile.png"),
          fullPage: true,
        });
      }
    } else if (role === "student") {
      await page.getByRole("button", { name: jm.profile, exact: true }).click();
      await page
        .getByRole("heading", { name: "Демо студент А", exact: true })
        .waitFor();
      check(
        !(await page.locator("main").innerText()).includes("Демо студент Б"),
        "student_never_receives_peer_card",
      );
      check(
        (
          await context.request.get(
            endpoint + `/journals/${journal.id}/roster?on=2026-10-29`,
          )
        ).status() === 403,
        "student_cannot_read_group_roster",
      );
      await fits(page, role);
      await page.screenshot({
        path: resolve(dir, "student-desktop.png"),
        fullPage: true,
      });
    } else {
      check(
        (await page
          .locator(".portal-primary-nav")
          .getByRole("button", { name: jm.title, exact: true })
          .count()) === 0,
        "scheduler_has_no_journal_nav",
      );
      check(
        (await context.request.get(endpoint + "/journals")).status() === 403,
        "scheduler_has_no_journal_read",
      );
    }
    await context.close();
  }
  check(errors.length === 0, "no_browser_errors");
  check(external.length === 0, "no_external_requests");
  console.log(
    JSON.stringify({ passed: true, checks: checks.length, roles: 5 }),
  );
} catch (e) {
  if (activePage && !activePage.isClosed())
    await activePage.screenshot({
      path: resolve(dir, "failure.png"),
      fullPage: true,
    });
  console.log(
    JSON.stringify({ passed: false, phase, reason: e.message.split("\n")[0] }),
  );
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  await writeFile(
    resolve(dir, "browser-report.json"),
    JSON.stringify(
      { passed: !process.exitCode, phase, checks, errors, external },
      null,
      2,
    ),
  );
}
