/** Loopback-only acceptance. Records/edits one explicitly synthetic lesson.
 * Credentials and screenshots stay in ignored .local; college records untouched.
 */
import { createRequire } from "node:module";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { kk } from "../src/locales/kk.ts";
import { wb } from "../src/locales/workbench.kk.ts";
import { portal } from "../src/locales/portal.kk.ts";
import { jm } from "../src/locales/journal.kk.ts";
import { lm } from "../src/locales/lesson.kk.ts";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { accounts, scope_id: scope } = JSON.parse(
  await readFile(resolve(root, ".local/accounts.json"), "utf8"),
);
const base = "http://127.0.0.1:8000";
const endpoint = `${base}/api/scopes/${scope}/journal`;
const dir = resolve(root, ".local/qa/journal-lessons");
await mkdir(dir, { recursive: true });
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
  page.on("pageerror", () => errors.push(role + ":pageerror"));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(role + ":console");
  });
  await page.route("**/*", async (route) => {
    if (new URL(route.request().url()).origin !== base) {
      external.push("external");
      await route.abort();
    } else await route.continue();
  });
  await page.goto(base);
  const a = accounts.find((a) => a.role === role);
  await page.getByLabel(kk.email, { exact: true }).fill(a.email);
  await page.getByLabel(kk.password, { exact: true }).fill(a.password);
  await page.getByRole("button", { name: kk.signIn, exact: true }).click();
  await page.getByRole("heading", { name: wb.overview, exact: true }).waitFor();
  return { page, context };
}
async function fits(page, label) {
  for (const width of [320, 360, 857, 1440]) {
    await page.setViewportSize({ width, height: width < 400 ? 800 : 1024 });
    check(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      `${label}_no_overflow_${width}`,
    );
  }
}
async function save(page) {
  const response = page.waitForResponse(
    (r) =>
      r.url() === endpoint + "/lesson-commands" &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: jm.save, exact: true }).click();
  const r = await response;
  check(r.ok(), "teacher_save_accepted");
  await page.getByText(lm.saved, { exact: true }).waitFor();
  await page.waitForLoadState("networkidle");
  return r.json();
}
async function openJournal(page) {
  await page.getByRole("button", { name: jm.title, exact: true }).click();
  await page
    .getByRole("button", { name: lm.open, exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: lm.openLesson, exact: true })
    .first()
    .waitFor();
}
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  });
  phase = "teacher";
  const teacher = await login("teacher");
  const catalog = await (
    await teacher.context.request.get(endpoint + "/journals")
  ).json();
  check(
    catalog.journals.length === 1 &&
      catalog.journals[0].data_kind === "synthetic",
    "only_synthetic_demo_journal",
  );
  const journal = catalog.journals[0];
  await openJournal(teacher.page);
  await teacher.page
    .getByRole("button", { name: lm.openLesson, exact: true })
    .first()
    .click();
  await teacher.page.getByLabel(lm.topic, { exact: true }).waitFor();
  check(
    await teacher.page.getByLabel(lm.topic, { exact: true }).isEnabled(),
    "assigned_teacher_can_edit",
  );
  check(
    await teacher.page
      .getByLabel(`${lm.attendance}: Демо студент А`, { exact: true })
      .isVisible(),
    "confirmed_roster_visible",
  );
  const isNew = await teacher.page
    .getByLabel(lm.conducted, { exact: true })
    .count();
  if (isNew) {
    check(
      (await teacher.page
        .getByLabel(`${lm.attendance}: Демо студент А`, { exact: true })
        .inputValue()) === "",
      "attendance_initially_unmarked",
    );
    await teacher.page
      .getByLabel(lm.topic, { exact: true })
      .fill("Демонстрациялық сабақ: күнделікті қарым-қатынас");
    await teacher.page
      .getByLabel(`${lm.attendance}: Демо студент А`, { exact: true })
      .selectOption("present");
    await teacher.page
      .getByLabel(`${lm.attendance}: Демо студент Б`, { exact: true })
      .selectOption("late");
    await teacher.page.getByLabel(lm.conducted, { exact: true }).check();
  } else {
    await teacher.page
      .getByLabel(lm.topic, { exact: true })
      .fill("Демонстрациялық сабақ: күнделікті қарым-қатынас");
    await teacher.page
      .getByLabel(lm.reason, { exact: true })
      .fill("Синтетикалық мысалдың қайталама тексеруі");
  }
  const receipt = await save(teacher.page);
  const before = await (
    await teacher.context.request.get(
      endpoint + `/lessons/${receipt.lesson_id}`,
    )
  ).json();
  check(
    before.recorded && before.students.length === 3,
    "recorded_snapshot_has_three_demo_students",
  );
  check(
    before.students.find((s) => s.display_name === "Демо студент В")
      .attendance === null,
    "unsubmitted_student_remains_unmarked",
  );
  phase = "teacher-correction";
  const bMark = teacher.page.getByLabel(`${lm.attendance}: Демо студент Б`, {
    exact: true,
  });
  await bMark.selectOption("excused");
  await teacher.page
    .getByLabel(lm.reason, { exact: true })
    .fill("Синтетикалық мысал: қатысу белгісін нақтылау");
  await save(teacher.page);
  check(
    (await bMark.inputValue()) === "excused",
    "corrected_attendance_rendered",
  );
  await teacher.page
    .getByRole("button", { name: lm.history, exact: true })
    .click();
  await teacher.page
    .getByRole("heading", { name: lm.history, exact: true })
    .waitFor();
  check(
    (await teacher.page
      .getByText(lm.actions.update_lesson, { exact: false })
      .count()) > 0,
    "history_visible",
  );
  await fits(teacher.page, "teacher");
  await teacher.page.screenshot({
    path: resolve(dir, "teacher-desktop.png"),
    fullPage: true,
  });
  await teacher.page.setViewportSize({ width: 360, height: 800 });
  await teacher.page.screenshot({
    path: resolve(dir, "teacher-mobile.png"),
    fullPage: true,
  });
  await teacher.page.setViewportSize({ width: 1440, height: 1024 });
  await teacher.page.getByLabel(lm.topic, { exact: true }).focus();
  await teacher.page.keyboard.press("Tab");
  check(
    await teacher.page.evaluate(
      () => document.activeElement?.tagName !== "BODY",
    ),
    "keyboard_focus_moves_within_form",
  );
  await teacher.page.reload();
  await teacher.page
    .getByRole("heading", { name: wb.overview, exact: true })
    .waitFor();
  await openJournal(teacher.page);
  await teacher.page
    .getByRole("button", { name: lm.openLesson, exact: true })
    .first()
    .click();
  await teacher.page.getByLabel(lm.topic, { exact: true }).waitFor();
  check(
    (await teacher.page
      .getByLabel(`${lm.attendance}: Демо студент Б`, { exact: true })
      .inputValue()) === "excused",
    "attendance_survives_reload",
  );
  const result = await (
    await teacher.context.request.get(
      endpoint + `/lessons/${receipt.lesson_id}`,
    )
  ).json();
  const deniedBody = {
    operation_id: crypto.randomUUID(),
    expected_revision: result.revision,
    expected_registry_revision: result.registry_revision,
    command: {
      kind: "update_lesson",
      lesson_id: receipt.lesson_id,
      topic: "Unauthorized",
      attendance: [],
      reason: "No",
    },
  };
  await teacher.context.close();
  for (const role of ["admin", "scheduler", "approver", "student"]) {
    phase = role;
    const session = await login(role);
    const auth = await (
      await session.context.request.get(base + "/api/auth/session")
    ).json();
    const refusal = await session.context.request.post(
      endpoint + "/lesson-commands",
      {
        headers: { Origin: base, "X-CSRF-Token": auth.csrf_token },
        data: deniedBody,
      },
    );
    check(refusal.status() === 403, `${role}_cannot_write_lesson`);
    const read = await session.context.request.get(
      endpoint + `/lessons/${receipt.lesson_id}`,
    );
    check(
      read.status() === (role === "approver" ? 200 : 403),
      `${role}_fact_read_policy`,
    );
    if (role === "approver") {
      await openJournal(session.page);
      await session.page
        .getByRole("button", { name: lm.openLesson, exact: true })
        .first()
        .click();
      await session.page.getByLabel(lm.topic, { exact: true }).waitFor();
      check(
        await session.page.getByLabel(lm.topic, { exact: true }).isDisabled(),
        "approver_form_read_only",
      );
      check(
        (await session.page
          .getByRole("button", { name: jm.save, exact: true })
          .count()) === 0,
        "approver_no_save_control",
      );
      await fits(session.page, role);
      await session.page.screenshot({
        path: resolve(dir, "approver-desktop.png"),
        fullPage: true,
      });
    }
    if (role === "admin") {
      await session.page
        .getByRole("button", { name: portal.sections, exact: true })
        .click();
      await session.page
        .getByRole("dialog")
        .getByRole("button", { name: jm.setup, exact: true })
        .click();
      await session.page
        .locator(".journal-tabs")
        .getByRole("button", { name: lm.admin, exact: true })
        .click();
      await session.page
        .getByLabel(lm.chooseJournal, { exact: true })
        .selectOption(journal.id);
      await session.page
        .getByRole("button", { name: lm.editRoster, exact: true })
        .first()
        .click();
      await session.page
        .getByLabel("Демо студент А", { exact: true })
        .waitFor();
      check(
        (await session.page.getByLabel(lm.topic, { exact: true }).count()) ===
          0,
        "admin_no_topic_input",
      );
      check(
        (await session.page
          .getByLabel(`${lm.attendance}: Демо студент А`, { exact: true })
          .count()) === 0,
        "admin_no_attendance_input",
      );
      await fits(session.page, role);
      await session.page.screenshot({
        path: resolve(dir, "admin-roster-desktop.png"),
        fullPage: true,
      });
    }
    if (role === "student") {
      await session.page
        .getByRole("button", { name: jm.profile, exact: true })
        .click();
      await session.page
        .getByRole("heading", { name: jm.profile, exact: true })
        .waitFor();
      check(
        (await session.page
          .getByText("Демо студент Б", { exact: true })
          .count()) === 0,
        "student_no_peer_data",
      );
    }
    await session.context.close();
  }
  check(errors.length === 0, "no_console_or_page_errors");
  check(external.length === 0, "no_external_requests");
  await writeFile(
    resolve(dir, "browser-report.json"),
    JSON.stringify(
      { checks, errors, external, roles: 5, synthetic_only: true },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      passed: checks.length,
      roles: 5,
      errors: errors.length,
      external: external.length,
    }),
  );
} catch (error) {
  if (activePage && !activePage.isClosed())
    await activePage
      .screenshot({ path: resolve(dir, "failure.png"), fullPage: true })
      .catch(() => {});
  await writeFile(
    resolve(dir, "browser-failure.json"),
    JSON.stringify({ phase, checks, errors, message: String(error) }, null, 2),
  );
  console.error("Journal lesson browser check failed at " + phase);
  process.exitCode = 1;
} finally {
  await browser?.close();
}
