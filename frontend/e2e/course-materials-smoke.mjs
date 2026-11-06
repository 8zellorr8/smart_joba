/** Uses generated fixture credentials from stdin and a disposable local test DB.
 * No credentials or source documents are written to the report. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { kk } from "../src/locales/kk.ts";
import { wb } from "../src/locales/workbench.kk.ts";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_MODULE || "playwright",
);
let input = "";
for await (const chunk of process.stdin) input += chunk;
const { base, accounts } = JSON.parse(input);
assert.equal(new URL(base).hostname, "127.0.0.1");
const dir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../.local/qa/course-materials",
);
await mkdir(dir, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
});
const checks = [],
  errors = [];
const button = (page, name) => page.getByRole("button", { name, exact: true });
const field = (page, name) => page.getByLabel(name, { exact: true });
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
  page.setDefaultTimeout(10000);
  page.on("pageerror", () => errors.push(role + ":pageerror"));
  await page.route("**/*", (route) => {
    if (new URL(route.request().url()).origin !== base) {
      errors.push("external-request");
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
async function save(page) {
  await button(page, "Сақтау").click();
  await page.getByText("Сақталды.", { exact: true }).waitFor();
  await page.locator(".course-form").waitFor({ state: "hidden" });
  await page
    .getByText("Жүктелуде…", { exact: true })
    .waitFor({ state: "hidden" });
}
function examplePdf() {
  const stream = "BT /F1 16 Tf 50 750 Td (Synthetic course handout) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n",
    offsets = [0];
  for (const [i, obj] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => String(n).padStart(10, "0") + " 00000 n \n")
    .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
try {
  const teacher = await login("teacher");
  await button(teacher, "Курстар").click();
  await button(teacher, "Курс құру").click();
  await button(teacher, "Тақырып қосу").click();
  await field(teacher, "Тақырып атауы").fill("Демо: Greetings");
  await save(teacher);
  check(
    await teacher
      .getByRole("heading", { name: "Демо: Greetings", exact: true })
      .isVisible(),
    "teacher_created_course_and_topic",
  );
  await button(teacher, "Материал қосу").click();
  await field(teacher, "Материал атауы").fill("Демо: Reading");
  await field(teacher, "Оқу мәтіні").fill(
    "Hello!\n<script>window.bad = true</script>",
  );
  // Explicitly inject one network failure; the user can retry the same command.
  await teacher.route(
    "**/courses/*/topics/*/materials",
    (route) => route.abort(),
    { times: 1 },
  );
  await button(teacher, "Сақтау").click();
  await teacher.getByRole("alert").waitFor();
  check(
    (await field(teacher, "Оқу мәтіні").inputValue()).startsWith("Hello!"),
    "failed_write_preserves_input",
  );
  await save(teacher);
  await button(teacher, "Материал қосу").click();
  await field(teacher, "Материал атауы").fill("Демо: Handout");
  await field(teacher, "Материал түрі").selectOption("pdf");
  const pdf = examplePdf();
  await field(teacher, "PDF файлы · 5 МБ дейін").setInputFiles({
    name: "demo.pdf",
    mimeType: "application/pdf",
    buffer: pdf,
  });
  await save(teacher);
  check(
    (await teacher.locator(".course-item").count()) === 2,
    "text_and_pdf_saved_without_duplicate",
  );
  const student = await login("student");
  await button(student, "Курстар").click();
  await button(student, "Курсқа кіру").click();
  await button(student, "Демо: Reading · Мәтін").click();
  await student.locator(".course-text").waitFor();
  check(
    (await student.locator(".course-text").innerText()).includes("<script>"),
    "text_rendered_literally",
  );
  check(await student.evaluate(() => !window.bad), "text_does_not_execute");
  check(
    (await button(student, "Тақырып қосу").count()) === 0 &&
      (await button(student, "Материал қосу").count()) === 0,
    "student_read_only",
  );
  const downloadEvent = student.waitForEvent("download");
  await button(student, "Демо: Handout · PDF жүктеу").click();
  const download = await downloadEvent;
  check(
    (await readFile(await download.path())).equals(pdf),
    "authenticated_download_matches_uploaded_pdf",
  );
  check(
    download.suggestedFilename().endsWith(".pdf"),
    "download_filename_is_pdf",
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
  await button(student, "Демо: Reading · Мәтін").focus();
  await student.keyboard.press("Tab");
  await student.keyboard.press("Shift+Tab");
  check(
    await button(student, "Демо: Reading · Мәтін").evaluate(
      (el) =>
        document.activeElement === el &&
        getComputedStyle(el).outlineStyle !== "none",
    ),
    "keyboard_focus_visible",
  );
  await student.reload();
  await button(student, "Курстар").click();
  await button(student, "Курсқа кіру").click();
  await student.locator(".course-item").first().waitFor();
  check(
    (await student.locator(".course-item").count()) === 2,
    "materials_survive_reload",
  );
  for (const role of ["admin", "scheduler", "approver"]) {
    const page = await login(role);
    check(
      (await button(page, "Курстар").count()) === 0,
      role + "_has_no_course_navigation",
    );
  }
  await student.route(
    "**/courses/*/materials/*",
    (route) =>
      route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "ACCESS_DENIED" } }),
      }),
    { times: 1 },
  );
  await button(student, "Демо: Handout · PDF жүктеу").click();
  await student
    .getByRole("alert")
    .filter({ hasText: "Курсты көруге рұқсат жоқ." })
    .waitFor();
  check(
    (await student.locator(".course-item").count()) === 0,
    "download_denial_clears_private_materials",
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
