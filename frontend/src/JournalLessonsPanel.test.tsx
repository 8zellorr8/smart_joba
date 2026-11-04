import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { JournalLessonsPanel } from "./JournalLessonsPanel";
import { JournalLessonAdmin } from "./JournalLessonAdmin";
import { lessonApi } from "./lesson-api";
import type { Lesson, LessonSummary } from "./lesson-api";
import { ApiError } from "./api";
import { jm } from "./locales/journal.kk";
import { lm } from "./locales/lesson.kk";

vi.mock("./lesson-api", () => ({
  lessonApi: {
    list: vi.fn(),
    preview: vi.fn(),
    get: vi.fn(),
    command: vi.fn(),
    history: vi.fn(),
    adminRoster: vi.fn(),
  },
}));
const journal = {
  id: "j",
  group: "Демо топ",
  subject: "Демо пән",
  academic_year: "2026-2027",
  data_kind: "synthetic",
  semester: 1,
};
const row: LessonSummary = {
  lesson_id: null,
  publication_id: "p",
  event_id: "e",
  date: "2026-09-01",
  start: "09:00",
  end: "10:30",
  recorded: false,
  needs_mapping: false,
  blocked: null,
};
const fixture: Lesson = {
  id: null,
  journal_id: "j",
  revision: 0,
  registry_revision: 7,
  recorded: false,
  topic: "",
  can_write: true,
  source: {
    publication_id: "p",
    event_id: "e",
    date: row.date,
    start: row.start,
    end: row.end,
    timezone: "Asia/Almaty",
    version_number: 5,
    publication_revision: 2,
    group: "Демо топ",
    subject: "Демо пән",
    teacher: "Демо оқытушы",
    room: "101",
  },
  students: [
    {
      student_id: "a",
      display_name: "Демо А",
      active: true,
      attendance: null,
      grade: null,
    },
    {
      student_id: "b",
      display_name: "Демо Б",
      active: true,
      attendance: null,
      grade: null,
    },
  ],
  source_changed: false,
  current_links: [],
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(lessonApi.list).mockResolvedValue({
    items: [row],
    total: 1,
    offset: 0,
    limit: 50,
    registry_revision: 7,
  });
  vi.mocked(lessonApi.preview).mockResolvedValue(structuredClone(fixture));
  vi.mocked(lessonApi.get).mockResolvedValue({
    ...structuredClone(fixture),
    id: "lesson",
    recorded: true,
    topic: "Тақырып",
    revision: 1,
  });
  vi.mocked(lessonApi.command).mockResolvedValue({
    lesson_id: "lesson",
    revision: 1,
    registry_revision: 7,
    kind: "record_lesson",
  });
  vi.mocked(lessonApi.history).mockResolvedValue({
    items: [],
    next_offset: null,
  });
});
async function open() {
  const expired = vi.fn(),
    dirty = vi.fn(),
    close = vi.fn();
  render(
    <JournalLessonsPanel
      scope="s"
      journal={journal}
      csrfToken="csrf"
      onExpired={expired}
      onDirtyChange={dirty}
      onClose={close}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: lm.openLesson }));
  await screen.findByLabelText(lm.topic);
  return { expired, dirty, close };
}
function fill() {
  fireEvent.change(screen.getByLabelText(lm.topic), {
    target: { value: "Тақырып" },
  });
  fireEvent.change(screen.getByLabelText(`${lm.attendance}: Демо А`), {
    target: { value: "late" },
  });
  fireEvent.click(screen.getByLabelText(lm.conducted));
  fireEvent.click(screen.getByRole("button", { name: jm.save }));
}
it("opens without creating facts, sends only changed rows and explicit confirmation", async () => {
  const { dirty } = await open();
  expect(lessonApi.command).not.toHaveBeenCalled();
  expect(screen.getByLabelText(`${lm.attendance}: Демо Б`)).toHaveValue("");
  fill();
  await screen.findByText(lm.saved);
  expect(lessonApi.command).toHaveBeenCalledWith(
    "s",
    "csrf",
    expect.objectContaining({
      expected_revision: 0,
      expected_registry_revision: 7,
      command: expect.objectContaining({
        kind: "record_lesson",
        topic: "Тақырып",
        conducted: true,
        attendance: [{ student_id: "a", value: "late" }],
      }),
    }),
    undefined,
  );
  await waitFor(() => expect(dirty).toHaveBeenLastCalledWith(false));
});
it("retains input and focuses a linked validation error", async () => {
  vi.mocked(lessonApi.command).mockRejectedValue(
    new ApiError(422, "JOURNAL_REQUIRED", { field: "reason" }),
  );
  await open();
  fill();
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveFocus();
  expect(screen.getByLabelText(lm.topic)).toHaveValue("Тақырып");
  expect(screen.getByLabelText(lm.reason)).toHaveAttribute(
    "aria-invalid",
    "true",
  );
});
it("unknown outcome freezes fields and retries the exact operation", async () => {
  vi.mocked(lessonApi.command).mockRejectedValueOnce(
    new ApiError(0, "network_error"),
  );
  await open();
  fireEvent.change(screen.getByLabelText(`${lm.grade}: Демо А`), {
    target: { value: "0" },
  });
  fill();
  await screen.findByText(jm.uncertain);
  expect(screen.getByLabelText(lm.topic)).toBeDisabled();
  expect(screen.getByLabelText(`${lm.grade}: Демо А`)).toBeDisabled();
  expect(screen.getByLabelText(`${lm.grade}: Демо А`)).toHaveValue("0");
  const original = vi.mocked(lessonApi.command).mock.calls[0][2];
  fireEvent.click(screen.getByRole("button", { name: jm.retrySave }));
  await screen.findByText(lm.saved);
  expect(vi.mocked(lessonApi.command).mock.calls[1][2]).toEqual(original);
});
it("stale keeps values and blocks saving until explicit reload", async () => {
  vi.mocked(lessonApi.command).mockRejectedValue(
    new ApiError(409, "JOURNAL_STALE"),
  );
  await open();
  fireEvent.change(screen.getByLabelText(`${lm.grade}: Демо А`), {
    target: { value: "100" },
  });
  fill();
  await screen.findByText(jm.stale);
  expect(screen.getByLabelText(lm.topic)).toHaveValue("Тақырып");
  expect(screen.getByLabelText(`${lm.grade}: Демо А`)).toHaveValue("100");
  expect(screen.getByRole("button", { name: jm.save })).toBeDisabled();
  vi.spyOn(window, "confirm").mockReturnValue(false);
  fireEvent.click(screen.getByRole("button", { name: jm.retry }));
  expect(screen.getByLabelText(lm.topic)).toHaveValue("Тақырып");
  vi.mocked(window.confirm).mockReturnValue(true);
  fireEvent.click(screen.getByRole("button", { name: jm.retry }));
  await waitFor(() => expect(screen.getByLabelText(lm.topic)).toHaveValue(""));
});
it("clears private content on 403 and requests login on 401", async () => {
  vi.mocked(lessonApi.command).mockRejectedValue(
    new ApiError(403, "ACCESS_DENIED"),
  );
  await open();
  fill();
  await screen.findByText(jm.denied);
  expect(screen.queryByText("Демо А")).not.toBeInTheDocument();
  expect(screen.queryByLabelText(lm.topic)).not.toBeInTheDocument();
});
it("distinguishes load failure from an empty journal", async () => {
  vi.mocked(lessonApi.list).mockRejectedValue(new ApiError(503, "unavailable"));
  render(
    <JournalLessonsPanel
      scope="s"
      journal={journal}
      csrfToken="csrf"
      onExpired={vi.fn()}
      onDirtyChange={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  await screen.findByText(jm.loadError);
  expect(screen.queryByText(lm.empty)).not.toBeInTheDocument();
});
it("read-only approver sees saved marks without write controls", async () => {
  vi.mocked(lessonApi.preview).mockResolvedValue({
    ...fixture,
    id: "lesson",
    recorded: true,
    topic: "Тақырып",
    can_write: false,
    students: [{ ...fixture.students[0], attendance: "absent" }],
  });
  await open();
  expect(screen.getByText(lm.attendanceValues.absent)).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: jm.save }),
  ).not.toBeInTheDocument();
  expect(screen.getByLabelText(lm.topic)).toBeDisabled();
});
it("does not treat a failed read after successful receipt as unknown save", async () => {
  vi.mocked(lessonApi.get).mockRejectedValue(new ApiError(503, "unavailable"));
  await open();
  fill();
  await screen.findByText(lm.loadSaved);
  expect(
    screen.queryByRole("button", { name: jm.retrySave }),
  ).not.toBeInTheDocument();
  expect(lessonApi.command).toHaveBeenCalledTimes(1);
});
it("history renders topic as text, with old value and reason", async () => {
  vi.mocked(lessonApi.preview).mockResolvedValue({
    ...fixture,
    id: "lesson",
    recorded: true,
    topic: "Тақырып",
    revision: 2,
  });
  vi.mocked(lessonApi.history).mockResolvedValue({
    items: [
      {
        id: "change",
        action: "update_lesson",
        actor_id: "actor",
        created_at: "2026-09-01T06:00:00Z",
        revision: 2,
        reason: "Түзету",
        before: { lesson: { topic: "Бұрынғы тақырып" } },
        after: { lesson: { topic: "<script>bad</script>" } },
      },
    ],
    next_offset: null,
  });
  await open();
  fireEvent.click(screen.getByRole("button", { name: lm.history }));
  await screen.findByText(/Бұрынғы тақырып/);
  expect(document.querySelector("script")).toBeNull();
});
it("admin roster edits send retained IDs and never need private attendance", async () => {
  vi.mocked(lessonApi.list).mockResolvedValue({
    items: [{ ...row, recorded: true, lesson_id: "lesson" }],
    total: 1,
    offset: 0,
    limit: 50,
    registry_revision: 7,
  });
  vi.mocked(lessonApi.adminRoster).mockResolvedValue({
    lesson_id: "lesson",
    revision: 2,
    registry_revision: 7,
    date: row.date,
    students: fixture.students,
  });
  render(
    <JournalLessonAdmin
      scope="s"
      journals={[journal]}
      csrfToken="csrf"
      onExpired={vi.fn()}
      onDirtyChange={vi.fn()}
      onRefresh={async () => {}}
    />,
  );
  fireEvent.change(screen.getByLabelText(lm.chooseJournal), {
    target: { value: "j" },
  });
  fireEvent.click(await screen.findByRole("button", { name: lm.editRoster }));
  fireEvent.click(await screen.findByLabelText("Демо А"));
  fireEvent.change(screen.getByLabelText(jm.reason), {
    target: { value: "Құрамды түзету" },
  });
  fireEvent.click(screen.getByRole("button", { name: jm.save }));
  await screen.findByText(jm.saved);
  expect(lessonApi.command).toHaveBeenCalledWith(
    "s",
    "csrf",
    expect.objectContaining({
      command: {
        kind: "correct_roster",
        lesson_id: "lesson",
        student_ids: ["b"],
        reason: "Құрамды түзету",
      },
    }),
    true,
  );
});

it("ignores a late preview response after leaving the selected lesson", async () => {
  let finish: (data: Lesson) => void = () => {};
  vi.mocked(lessonApi.preview).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  render(
    <JournalLessonsPanel
      scope="s"
      journal={journal}
      csrfToken="csrf"
      onExpired={vi.fn()}
      onDirtyChange={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: lm.openLesson }));
  fireEvent.click(screen.getByRole("button", { name: lm.back }));
  await act(async () => {
    finish(fixture);
  });
  await screen.findByRole("button", { name: lm.openLesson });
  expect(screen.queryByLabelText(lm.topic)).not.toBeInTheDocument();
});

it("requires fresh login after a 401 save response", async () => {
  vi.mocked(lessonApi.command).mockRejectedValue(
    new ApiError(401, "AUTH_REQUIRED"),
  );
  const { expired } = await open();
  fill();
  await waitFor(() => expect(expired).toHaveBeenCalledOnce());
});
it("sends zero and 100 as numeric grades, without deriving attendance", async () => {
  await open();
  expect(screen.getByLabelText(`${lm.grade}: Демо А`)).toHaveValue("");
  expect(screen.getAllByText(lm.ungraded)).toHaveLength(2);
  fireEvent.change(screen.getByLabelText(lm.topic), {
    target: { value: "Тақырып" },
  });
  fireEvent.change(screen.getByLabelText(`${lm.grade}: Демо А`), {
    target: { value: "0" },
  });
  fireEvent.change(screen.getByLabelText(`${lm.grade}: Демо Б`), {
    target: { value: "100" },
  });
  fireEvent.click(screen.getByLabelText(lm.conducted));
  fireEvent.click(screen.getByRole("button", { name: jm.save }));
  await screen.findByText(lm.saved);
  expect(vi.mocked(lessonApi.command).mock.calls[0][2].command).toMatchObject({
    grades: [
      { student_id: "a", value: 0 },
      { student_id: "b", value: 100 },
    ],
    attendance: [],
  });
});

it.each(["-1", "101", "75.5", "letters", "1e2"])(
  "retains invalid grade %s and focuses linked error without saving",
  async (value) => {
    await open();
    const input = screen.getByLabelText(`${lm.grade}: Демо А`);
    fireEvent.change(input, { target: { value } });
    fireEvent.blur(input);
    expect(input).toHaveAttribute("aria-invalid", "true");
    fill();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveFocus());
    expect(input).toHaveValue(value);
    expect(
      screen.getByRole("link", { name: `Демо А: ${lm.grade}` }),
    ).toHaveAttribute("href", "#lesson-grade-a");
    expect(lessonApi.command).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "75" } });
    fireEvent.blur(input);
    expect(input).not.toHaveAttribute("aria-invalid");
    fireEvent.click(screen.getByRole("button", { name: jm.save }));
    await screen.findByText(lm.saved);
  },
);

it("clears saved zero explicitly, retains input after reason error, and sends only changed grade", async () => {
  const recorded = {
    ...structuredClone(fixture),
    id: "lesson",
    topic: "Тақырып",
    recorded: true,
    revision: 2,
    students: [
      { ...fixture.students[0], grade: 0 },
      { ...fixture.students[1], grade: 100 },
    ],
  };
  vi.mocked(lessonApi.preview).mockResolvedValue(recorded);
  vi.mocked(lessonApi.command).mockRejectedValueOnce(
    new ApiError(422, "JOURNAL_REQUIRED", { field: "reason" }),
  );
  vi.mocked(lessonApi.get).mockResolvedValue({
    ...recorded,
    revision: 3,
    students: [{ ...recorded.students[0], grade: null }, recorded.students[1]],
  });
  await open();
  const input = screen.getByLabelText(`${lm.grade}: Демо А`);
  expect(input).toHaveValue("0");
  fireEvent.change(input, { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: jm.save }));
  await screen.findByRole("alert");
  expect(input).toHaveValue("");
  expect(screen.getByLabelText(lm.reason)).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  expect(vi.mocked(lessonApi.command).mock.calls[0][2].command).toMatchObject({
    grades: [{ student_id: "a", value: null }],
    attendance: [],
    topic: null,
  });
  fireEvent.change(screen.getByLabelText(lm.reason), {
    target: { value: "Демо: бағаны түзету" },
  });
  fireEvent.click(screen.getByRole("button", { name: jm.save }));
  await screen.findByText(lm.saved);
  expect(input).toHaveValue("");
  expect(screen.getByLabelText(`${lm.grade}: Демо Б`)).toHaveValue("100");
});

it("shows grade clearing history and ignores absent grade keys in legacy history", async () => {
  vi.mocked(lessonApi.preview).mockResolvedValue({
    ...structuredClone(fixture),
    id: "lesson",
    topic: "Тақырып",
    recorded: true,
    can_write: false,
    students: [
      { ...fixture.students[0], grade: 0 },
      { ...fixture.students[1], grade: null },
    ],
  });
  const { grade: _grade, ...legacyStudent } = fixture.students[0];
  vi.mocked(lessonApi.history).mockResolvedValue({
    items: [
      {
        id: "new",
        action: "update_lesson",
        actor_id: "actor",
        actor_name: "Демо оқытушы",
        created_at: "2026-10-29T10:00:00+00:00",
        reason: "Демо түзету",
        revision: 3,
        before: { students: [{ ...fixture.students[0], grade: 0 }] },
        after: { students: [fixture.students[0]] },
      },
      {
        id: "old",
        action: "record_lesson",
        actor_id: "actor",
        created_at: "2026-10-28T10:00:00+00:00",
        reason: "",
        revision: 1,
        before: {},
        after: { students: [legacyStudent] },
      },
    ],
    next_offset: null,
  });
  await open();
  expect(
    screen.queryByLabelText(`${lm.grade}: Демо А`),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("cell", { name: "0" })).toBeInTheDocument();
  expect(screen.getByRole("cell", { name: lm.ungraded })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: lm.history }));
  expect(
    await screen.findByText(`Демо А · ${lm.grade}: 0 → ${lm.ungraded}`),
  ).toBeInTheDocument();
  expect(
    screen.queryByText(`${lm.ungraded} → ${lm.ungraded}`, { exact: false }),
  ).not.toBeInTheDocument();
});

it("keeps a removed student's grade visible but forbids editing that row", async () => {
  vi.mocked(lessonApi.preview).mockResolvedValue({
    ...structuredClone(fixture),
    id: "lesson",
    topic: "Тақырып",
    recorded: true,
    students: [
      { ...fixture.students[0], active: false, grade: 75 },
      fixture.students[1],
    ],
  });
  await open();
  expect(screen.getByRole("cell", { name: "75" })).toBeInTheDocument();
  expect(
    screen.queryByLabelText(`${lm.grade}: Демо А`),
  ).not.toBeInTheDocument();
  expect(screen.getByLabelText(`${lm.grade}: Демо Б`)).toBeEnabled();
});
