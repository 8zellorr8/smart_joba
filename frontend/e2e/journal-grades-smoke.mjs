/** Loopback-only, synthetic-only grade acceptance. No credentials in output. */
import { createRequire } from "node:module";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { kk } from "../src/locales/kk.ts";
import { wb } from "../src/locales/workbench.kk.ts";
import { jm } from "../src/locales/journal.kk.ts";
import { lm } from "../src/locales/lesson.kk.ts";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { accounts, scope_id: scope } = JSON.parse(
  await readFile(resolve(root, ".local/accounts.json"), "utf8"),
);
const base = "http://127.0.0.1:8000",
  endpoint = `${base}/api/scopes/${scope}/journal`;
const dir = resolve(root, ".local/qa/journal-grades");
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
  page.on("pageerror", () => errors.push(`${role}:pageerror`));
  page.on("console", (m) => {
    if (
      m.type() === "error" &&
      !m.text().includes("status of 422") &&
      !m.text().includes("status of 403")
    )
      errors.push(`${role}:console`);
  });
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
async function openLesson(page) {
  await page.getByRole("button", { name: jm.title, exact: true }).click();
  await page
    .getByRole("button", { name: lm.open, exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: lm.openLesson, exact: true })
    .first()
    .click();
  await page.getByLabel(lm.topic, { exact: true }).waitFor();
}
async function save(page, status = 200) {
  const response = page.waitForResponse(
    (r) =>
      r.url() === endpoint + "/lesson-commands" &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: jm.save, exact: true }).click();
  const r = await response;
  check(r.status() === status, `save_status_${status}`);
  if (status === 200) {
    await page.getByText(lm.saved, { exact: true }).waitFor();
    await page.waitForLoadState("networkidle");
  }
  return r.json();
}
async function fits(page, label) {
  for (const width of [320, 360, 857, 1440]) {
    await page.setViewportSize({ width, height: width < 400 ? 800 : 1024 });
    check(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      `${label}_fits_${width}`,
    );
  }
}
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  });
  phase = "teacher";
  const t = await login("teacher");
  const catalog = await (
    await t.context.request.get(endpoint + "/journals")
  ).json();
  check(
    catalog.journals.length === 1 &&
      catalog.journals[0].data_kind === "synthetic",
    "synthetic_journal_only",
  );
  const list = await (
    await t.context.request.get(
      endpoint + `/journals/${catalog.journals[0].id}/lessons`,
    )
  ).json();
  const entry = list.items[0];
  check(!!entry?.lesson_id, "existing_recorded_synthetic_lesson");
  const lessonUrl = endpoint + `/lessons/${entry.lesson_id}`;
  const before = await (await t.context.request.get(lessonUrl)).json();
  check(
    before.students.length === 3 && before.students.every((s) => s.active),
    "three_active_demo_students",
  );
  const [a, b, c] = before.students;
  check(c.grade === null, "third_grade_unfilled");
  await openLesson(t.page);
  const input = (name) =>
    t.page.getByLabel(`${lm.grade}: ${name}`, { exact: true });
  await input(a.display_name).fill("0");
  await input(b.display_name).fill("100");
  await t.page
    .getByLabel(lm.reason, { exact: true })
    .fill("Демо: шкаланың шектерін тексеру");
  let receipt = await save(t.page);
  let result = await (await t.context.request.get(lessonUrl)).json();
  const values = () =>
    Object.fromEntries(result.students.map((s) => [s.student_id, s.grade]));
  check(
    values()[a.student_id] === 0 &&
      values()[b.student_id] === 100 &&
      values()[c.student_id] === null,
    "zero_100_null_distinct",
  );
  check(
    JSON.stringify(result.students.map((s) => s.attendance)) ===
      JSON.stringify(before.students.map((s) => s.attendance)),
    "grades_do_not_derive_attendance",
  );
  let gradePosts = 0;
  t.page.on("request", (r) => {
    if (r.url() === endpoint + "/lesson-commands" && r.method() === "POST")
      gradePosts++;
  });
  await input(a.display_name).fill("75.5");
  await t.page.getByRole("button", { name: jm.save, exact: true }).click();
  await t.page.getByRole("alert").waitFor();
  check(
    gradePosts === 0 && (await input(a.display_name).inputValue()) === "75.5",
    "invalid_decimal_retained_without_write",
  );
  check(
    await t.page
      .getByRole("alert")
      .evaluate((el) => el === document.activeElement),
    "validation_summary_focused",
  );
  await input(a.display_name).fill("75");
  await save(t.page, 422);
  check(
    (await input(a.display_name).inputValue()) === "75",
    "reason_error_keeps_grade",
  );
  await t.page
    .getByLabel(lm.reason, { exact: true })
    .fill("Демо: бағалауды нақтылау");
  receipt = await save(t.page);
  await input(a.display_name).fill("");
  await save(t.page, 422);
  await t.page
    .getByLabel(lm.reason, { exact: true })
    .fill("Демо: қате бағаны өшіру");
  receipt = await save(t.page);
  result = await (await t.context.request.get(lessonUrl)).json();
  check(
    values()[a.student_id] === null && values()[b.student_id] === 100,
    "clearing_is_null_other_student_unchanged",
  );
  await t.page.getByRole("button", { name: lm.history, exact: true }).click();
  await t.page
    .locator(".lesson-history-row")
    .first()
    .getByText(`${a.display_name} · ${lm.grade}: 75 → ${lm.ungraded}`, {
      exact: true,
    })
    .waitFor();
  check(true, "previous_grade_visible_after_clear");
  // Leave useful boundary examples for the local demo; no academic result is invented.
  await input(a.display_name).fill("0");
  receipt = await save(t.page);
  result = await (await t.context.request.get(lessonUrl)).json();
  check(
    JSON.stringify(result.source) === JSON.stringify(before.source),
    "origin_unchanged",
  );
  check(
    !("average" in result) && !("final_grade" in result),
    "no_invented_totals",
  );
  await fits(t.page, "teacher");
  await t.page.getByRole("button", { name: lm.history, exact: true }).click();
  await t.page
    .getByText(`${a.display_name} · ${lm.grade}: ${lm.ungraded} → 0`, {
      exact: true,
    })
    .first()
    .waitFor();
  await t.page.getByRole("heading", { name: jm.title, exact: true }).click();
  await t.page.screenshot({
    path: resolve(dir, "teacher-desktop.png"),
    fullPage: true,
  });
  await t.page.setViewportSize({ width: 360, height: 800 });
  // Keyboard-only entry and save: Tab scrolls the grade input into view.
  await t.page
    .getByLabel(`${lm.attendance}: ${b.display_name}`, { exact: true })
    .focus();
  await t.page.keyboard.press("Tab");
  check(
    await input(b.display_name).evaluate((el) => el === document.activeElement),
    "grade_keyboard_focus",
  );
  check(
    await input(b.display_name).evaluate((el) => {
      const r = el.getBoundingClientRect();
      return (
        r.left >= 0 &&
        r.right <= innerWidth &&
        getComputedStyle(el).outlineStyle !== "none"
      );
    }),
    "grade_focus_visible_inside_mobile",
  );
  await t.page.keyboard.press("Control+a");
  await t.page.keyboard.type("99");
  await t.page.keyboard.press("Tab");
  // Proceed through the third row to the reason, then save with Enter.
  for (
    let i = 0;
    i < 8 &&
    !(await t.page
      .getByLabel(lm.reason, { exact: true })
      .evaluate((el) => el === document.activeElement));
    i++
  )
    await t.page.keyboard.press("Tab");
  check(
    await t.page
      .getByLabel(lm.reason, { exact: true })
      .evaluate((el) => el === document.activeElement),
    "reason_keyboard_reachable",
  );
  await t.page.keyboard.type("Демо: пернетақтамен түзету");
  await t.page.keyboard.press("Tab");
  check(
    await t.page
      .getByRole("button", { name: jm.save, exact: true })
      .evaluate((el) => el === document.activeElement),
    "save_keyboard_reachable",
  );
  const keyboardSave = t.page.waitForResponse(
    (r) =>
      r.url() === endpoint + "/lesson-commands" &&
      r.request().method() === "POST",
  );
  await t.page.keyboard.press("Enter");
  check((await keyboardSave).status() === 200, "keyboard_grade_saved");
  await t.page.getByText(lm.saved, { exact: true }).waitFor();
  await t.page.waitForLoadState("networkidle");
  check(
    (await input(b.display_name).inputValue()) === "99",
    "keyboard_value_confirmed",
  );
  await input(b.display_name).fill("100");
  await t.page
    .getByLabel(lm.reason, { exact: true })
    .fill("Демо: шекті мәнді қайтару");
  receipt = await save(t.page);
  await t.page.getByRole("heading", { name: jm.title, exact: true }).click();
  await t.page.screenshot({
    path: resolve(dir, "teacher-mobile.png"),
    fullPage: true,
  });
  await t.page.reload();
  await t.page
    .getByRole("heading", { name: wb.overview, exact: true })
    .waitFor();
  await openLesson(t.page);
  check(
    (await input(a.display_name).inputValue()) === "0" &&
      (await input(b.display_name).inputValue()) === "100" &&
      (await input(c.display_name).inputValue()) === "",
    "grades_persist_after_reload",
  );
  await t.context.close();
  for (const role of ["approver", "admin", "scheduler", "student"]) {
    phase = role;
    const s = await login(role);
    const auth = await (
      await s.context.request.get(base + "/api/auth/session")
    ).json();
    const denied = await s.context.request.post(endpoint + "/lesson-commands", {
      headers: { Origin: base, "X-CSRF-Token": auth.csrf_token },
      data: {
        operation_id: crypto.randomUUID(),
        expected_revision: receipt.revision,
        expected_registry_revision: receipt.registry_revision,
        command: {
          kind: "update_lesson",
          lesson_id: entry.lesson_id,
          grades: [{ student_id: a.student_id, value: 85 }],
          reason: "Unauthorized",
        },
      },
    });
    check(denied.status() === 403, `${role}_cannot_change_grade`);
    const read = await s.context.request.get(lessonUrl);
    check(
      read.status() === (role === "approver" ? 200 : 403),
      `${role}_read_policy`,
    );
    if (role === "approver") {
      await openLesson(s.page);
      check(
        (await s.page.getByRole("cell", { name: "0", exact: true }).count()) ===
          1 &&
          (await s.page
            .getByRole("cell", { name: "100", exact: true })
            .count()) === 1,
        "approver_sees_numeric_boundaries",
      );
      check(
        (await s.page
          .getByLabel(`${lm.grade}: ${a.display_name}`, { exact: true })
          .count()) === 0,
        "approver_has_no_grade_input",
      );
      await fits(s.page, "approver");
      await s.page.screenshot({
        path: resolve(dir, "approver-desktop.png"),
        fullPage: true,
      });
    }
    if (role === "admin") {
      const projection = await (
        await s.context.request.get(
          endpoint + `/lesson-admin/lessons/${entry.lesson_id}/roster`,
        )
      ).json();
      check(
        !JSON.stringify(projection).includes("grade"),
        "admin_roster_excludes_grades",
      );
    }
    if (role === "student") {
      const ownResponse = await s.context.request.get(endpoint + "/me");
      check(ownResponse.status() === 200, "student_profile_available");
      const own = await ownResponse.json();
      check(typeof own.student?.id === "string", "student_binding_confirmed");
      check(
        before.students
          .filter((student) => student.student_id !== own.student.id)
          .every(
            (student) => !JSON.stringify(own).includes(student.student_id),
          ),
        "student_profile_has_no_peer_rows",
      );
    }
    await s.context.close();
  }
  check(errors.length === 0, "no_unexpected_console_errors");
  check(external.length === 0, "no_external_requests");
  await writeFile(
    resolve(dir, "browser-report.json"),
    JSON.stringify({ checks, errors, external, roles: 5 }, null, 2),
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
  console.error(`Grade browser acceptance failed in ${phase}: ${e.message}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
}
