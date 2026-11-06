/** Credentials arrive over stdin; all records belong to a disposable fixture DB. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { kk } from "../src/locales/kk.ts";
import { wb } from "../src/locales/workbench.kk.ts";
import { tm } from "../src/locales/tasks.kk.ts";
const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_MODULE || "playwright",
);
let input = "";
for await (const chunk of process.stdin) input += chunk;
const { base, accounts } = JSON.parse(input);
assert.equal(new URL(base).hostname, "127.0.0.1");
const dir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../.local/qa/course-assignments",
);
await mkdir(dir, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
});
const checks = [],
  errors = [];
const button = (p, name) => p.getByRole("button", { name, exact: true }),
  field = (p, name) => p.getByLabel(name, { exact: true });
function check(value, name) {
  assert.ok(value, name);
  checks.push(name);
}
async function login(role) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on("pageerror", () => errors.push(role + ":pageerror"));
  await page.route("**/*", (route) => {
    if (new URL(route.request().url()).origin !== base) {
      errors.push("external");
      return route.abort();
    }
    return route.continue();
  });
  await page.goto(base);
  await field(page, kk.email).fill(accounts[role].email);
  await field(page, kk.password).fill(accounts[role].password);
  await button(page, kk.signIn).click();
  await page.getByRole("heading", { name: wb.overview, exact: true }).waitFor();
  return page;
}
async function save(page, name = tm.save) {
  await button(page, name).click();
  await page.getByText(tm.saved, { exact: true }).waitFor();
  await page
    .getByText(tm.loading, { exact: true })
    .waitFor({ state: "hidden" });
}
async function refresh(page) {
  await button(page, tm.refresh).click();
  await page
    .getByRole("heading", { name: "Демо: Dialogue", exact: true })
    .waitFor();
  await page
    .getByText(tm.loading, { exact: true })
    .waitFor({ state: "hidden" });
}
async function openTask(page) {
  await button(page, "Курстар").click();
  await button(page, "Курсқа кіру").click();
  await button(page, "Демо: Dialogue · " + tm.open).click();
  await page
    .getByRole("heading", { name: "Демо: Dialogue", exact: true })
    .waitFor();
}
async function selectResponse(page) {
  await page.locator(".task-response").first().click();
  await page.locator(".task-attempt").first().waitFor();
}
try {
  const teacher = await login("teacher");
  await button(teacher, "Курстар").click();
  await button(teacher, "Курс құру").click();
  await button(teacher, "Тақырып қосу").click();
  await field(teacher, "Тақырып атауы").fill("Демо тақырып");
  await save(teacher);
  await button(teacher, tm.add).click();
  await field(teacher, tm.title).fill("Демо: Dialogue");
  await field(teacher, tm.instructions).fill(
    "Write a short dialogue. This is synthetic practice.",
  );
  await field(teacher, tm.due).fill("2000-01-01");
  await save(teacher);
  await button(teacher, "Демо: Dialogue · " + tm.open).click();
  await teacher.getByText(tm.empty, { exact: true }).waitFor();
  checks.push("teacher_created_task_with_deadline");
  const student = await login("student");
  await openTask(student);
  await field(student, tm.answer).fill("Hello! How are you?");
  const dismiss = student
    .waitForEvent("dialog")
    .then((dialog) => dialog.dismiss());
  await student.getByRole("link", { name: "Басты бет", exact: true }).click();
  await dismiss;
  check(
    (await field(student, tm.answer).inputValue()) === "Hello! How are you?",
    "unsaved_answer_navigation_guard",
  );
  await student.route("**/tasks/*/submissions", (route) => route.abort(), {
    times: 1,
  });
  await button(student, tm.submit).click();
  await student.getByRole("alert").waitFor();
  check(
    (await field(student, tm.answer).inputValue()) === "Hello! How are you?",
    "failed_submission_keeps_text",
  );
  await save(student, tm.submit);
  await student.getByText(tm.submitted, { exact: true }).waitFor();
  check(
    (await button(student, tm.submit).count()) === 0,
    "pending_answer_not_resubmittable",
  );
  check(
    (await student.getByText(tm.late, { exact: true }).count()) > 0,
    "late_answer_is_labelled",
  );
  await refresh(teacher);
  await selectResponse(teacher);
  await field(teacher, tm.outcome).selectOption("returned");
  await field(teacher, tm.feedback).fill("Add one more question.");
  await save(teacher);
  await refresh(student);
  await student.getByText("Add one more question.", { exact: true }).waitFor();
  check(
    await button(student, tm.submit).isVisible(),
    "returned_answer_can_be_resubmitted",
  );
  const pdf = Buffer.from(
    "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n",
  );
  await field(student, tm.answerKind).selectOption("pdf");
  await field(student, tm.pdf).setInputFiles({
    name: "answer.pdf",
    mimeType: "application/pdf",
    buffer: pdf,
  });
  await save(student, tm.submit);
  check(
    (await student.locator(".task-attempt").count()) === 2,
    "resubmission_preserves_first_attempt",
  );
  await refresh(teacher);
  await selectResponse(teacher);
  const event = teacher.waitForEvent("download");
  await button(teacher, tm.download).click();
  const download = await event;
  check(
    (await readFile(await download.path())).equals(pdf),
    "teacher_downloads_exact_private_response",
  );
  await field(teacher, tm.grade).fill("0");
  await field(teacher, tm.feedback).fill("Check the examples.");
  await save(teacher);
  await refresh(student);
  check(
    (await student.locator(".task-attempt").first().innerText()).includes(
      tm.graded + ": 0",
    ),
    "student_sees_numeric_zero",
  );
  await selectResponse(teacher);
  await field(teacher, tm.grade).fill("85");
  await field(teacher, tm.reason).fill("Private: rechecked rubric");
  await field(teacher, tm.feedback).fill("Good work.");
  await save(teacher);
  await refresh(student);
  const personal = await student.locator(".task-attempt").first().innerText();
  check(
    personal.includes(tm.graded + ": 85") &&
      personal.includes(tm.graded + ": 0"),
    "student_sees_correction_and_previous_grade",
  );
  check(
    !personal.includes("Private: rechecked rubric"),
    "private_correction_reason_not_exposed",
  );
  for (const page of [teacher, student]) {
    for (const width of [320, 360, 857, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      check(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
        `${page === teacher ? "teacher" : "student"}_no_overflow_${width}`,
      );
      if (width === 320 || width === 1440)
        await page.screenshot({
          path: resolve(
            dir,
            `${page === teacher ? "teacher" : "student"}-${width}.png`,
          ),
          fullPage: true,
        });
    }
  }
  await button(student, tm.refresh).focus();
  await student.keyboard.press("Tab");
  await student.keyboard.press("Shift+Tab");
  check(
    await button(student, tm.refresh).evaluate(
      (el) =>
        document.activeElement === el &&
        getComputedStyle(el).outlineStyle !== "none",
    ),
    "keyboard_focus_visible",
  );
  await student.reload();
  await student
    .getByRole("heading", { name: wb.overview, exact: true })
    .waitFor();
  await openTask(student);
  await student.locator(".task-attempt").first().waitFor();
  check(
    (await student.locator(".task-attempt").first().innerText()).includes(
      tm.graded + ": 85",
    ),
    "result_survives_reload",
  );
  await student.route(
    "**/tasks/*/submissions/*/pdf",
    (route) =>
      route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "ACCESS_DENIED" } }),
      }),
    { times: 1 },
  );
  await button(student, tm.download).click();
  await student.getByRole("alert").waitFor();
  check(
    (await student.locator(".task-attempt").count()) === 0,
    "denied_download_clears_answers",
  );
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(dir, "browser.json"),
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ passed: checks.length, errors }));
} finally {
  await browser.close();
}
