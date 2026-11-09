import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { TeacherQueue } from "./TeacherQueue";
import { teacherQueueApi } from "./teacher-queue-api";

vi.mock("./teacher-queue-api", () => ({
  teacherQueueApi: { submissions: vi.fn(), attendance: vi.fn() },
}));

const submission = {
  id: "answer",
  course_id: "course",
  task_id: "task",
  title: "Демо тапсырма",
  student_name: "Демо студент",
  submitted_at: "2026-11-06T10:00:00Z",
  attempt: 1,
  subject: "Демо пән",
  group: "101-А",
  data_kind: "synthetic",
  timezone: "Asia/Almaty",
};
const lesson = {
  id: "lesson",
  journal_id: "journal",
  date: "2026-11-06",
  start: "09:00",
  subject: "Демо пән",
  group: "101-А",
  data_kind: "synthetic",
  missing: 2,
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(teacherQueueApi.submissions).mockResolvedValue({
    items: [submission],
    next: null,
  });
  vi.mocked(teacherQueueApi.attendance).mockResolvedValue({
    items: [lesson],
    next: null,
  });
});

it("opens the exact submission and recorded lesson", async () => {
  const onOpenTask = vi.fn();
  const onOpenLesson = vi.fn();
  render(
    <TeacherQueue
      scope="scope"
      onExpired={vi.fn()}
      onOpenTask={onOpenTask}
      onOpenLesson={onOpenLesson}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: /Демо тапсырма/ }));
  fireEvent.click(screen.getByRole("button", { name: /Белгісіз қатысу/ }));
  expect(onOpenTask).toHaveBeenCalledWith("course", "task", "answer");
  expect(onOpenLesson).toHaveBeenCalledWith("journal", "lesson");
});

it("loads another page and clears entries when access is revoked", async () => {
  vi.mocked(teacherQueueApi.submissions)
    .mockResolvedValueOnce({
      items: [submission],
      next: { at: submission.submitted_at, id: submission.id },
    })
    .mockResolvedValueOnce({
      items: [{ ...submission, id: "answer-2" }],
      next: null,
    });
  const { rerender } = render(
    <TeacherQueue
      scope="scope"
      onExpired={vi.fn()}
      onOpenTask={vi.fn()}
      onOpenLesson={vi.fn()}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Тағы көрсету" }));
  await waitFor(() =>
    expect(teacherQueueApi.submissions).toHaveBeenCalledTimes(2),
  );
  expect(screen.getAllByRole("button", { name: /Демо тапсырма/ })).toHaveLength(
    2,
  );
  vi.mocked(teacherQueueApi.submissions).mockRejectedValue(
    new ApiError(403, "ACCESS_DENIED"),
  );
  rerender(
    <TeacherQueue
      scope="other"
      onExpired={vi.fn()}
      onOpenTask={vi.fn()}
      onOpenLesson={vi.fn()}
    />,
  );
  await screen.findByRole("alert");
  expect(
    screen.queryByRole("button", { name: /Демо тапсырма/ }),
  ).not.toBeInTheDocument();
});
