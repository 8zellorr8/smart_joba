import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { CourseTaskPage, TaskCreateForm } from "./CourseTaskPage";
import { taskApi } from "./task-api";
import type { Submission, TaskDetails } from "./task-api";
import { tm } from "./locales/tasks.kk";

vi.mock("./task-api", () => ({
  taskApi: {
    get: vi.fn(),
    submissions: vi.fn(),
    attempts: vi.fn(),
    submit: vi.fn(),
    review: vi.fn(),
    pdf: vi.fn(),
  },
}));
const base: TaskDetails = {
  task: {
    id: "task",
    title: "Greetings task",
    instructions: "Write a dialogue.",
    due_on: "2026-11-10",
    timezone: "Asia/Qyzylorda",
  },
  can_manage: false,
  attempts: [],
};
const submission: Submission = {
  id: "answer",
  student_name: "Демо студент",
  attempt: 1,
  submitted_at: "2026-11-06T10:00:00Z",
  kind: "text",
  text: "Hello!",
  late: false,
  review: null,
  reviews: [],
};
const returned: Submission = {
  ...submission,
  review: {
    revision: 1,
    outcome: "returned",
    grade: null,
    feedback: "Add a question",
    created_at: "2026-11-06T11:00:00Z",
  },
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(taskApi.get).mockResolvedValue(structuredClone(base));
  vi.mocked(taskApi.submissions).mockResolvedValue({
    items: [submission],
    next: null,
  });
  vi.mocked(taskApi.attempts).mockResolvedValue({ attempts: [submission] });
});
function mount() {
  const onDenied = vi.fn(),
    onDirtyChange = vi.fn();
  return {
    ...render(
      <CourseTaskPage
        scope="scope"
        course="course"
        task="task"
        csrfToken="csrf"
        onDenied={onDenied}
        onBack={vi.fn()}
        onDirtyChange={onDirtyChange}
      />,
    ),
    onDenied,
    onDirtyChange,
  };
}
async function answer() {
  const field = await screen.findByLabelText(tm.answer);
  fireEvent.change(field, { target: { value: "My answer" } });
  fireEvent.click(screen.getByRole("button", { name: tm.submit }));
}
async function teacher(reviewed = false) {
  vi.mocked(taskApi.get).mockResolvedValue({ ...base, can_manage: true });
  if (reviewed)
    vi.mocked(taskApi.attempts).mockResolvedValue({
      attempts: [
        {
          ...submission,
          review: {
            revision: 1,
            outcome: "graded",
            grade: 80,
            feedback: "Good",
            created_at: "2026-11-06T11:00:00Z",
          },
        },
      ],
    });
  const result = mount();
  fireEvent.click(await screen.findByRole("button", { name: /Демо студент/ }));
  await screen.findByLabelText(tm.grade);
  return result;
}
it("shows deadline in course timezone and marks dirty input", async () => {
  const { onDirtyChange } = mount();
  await screen.findByText("10.11.2026");
  fireEvent.change(screen.getByLabelText(tm.answer), {
    target: { value: "Hi" },
  });
  expect(onDirtyChange).toHaveBeenCalledWith(true);
  expect(
    screen.queryByRole("heading", { name: tm.responses }),
  ).not.toBeInTheDocument();
});
it("keeps an answer and operation ID after a network failure", async () => {
  vi.mocked(taskApi.submit).mockRejectedValue(new ApiError(0, "network_error"));
  mount();
  await answer();
  await screen.findByText(tm.error);
  expect(screen.getByLabelText(tm.answer)).toHaveValue("My answer");
  fireEvent.click(screen.getByRole("button", { name: tm.submit }));
  await waitFor(() => expect(taskApi.submit).toHaveBeenCalledTimes(2));
  const calls = vi.mocked(taskApi.submit).mock.calls;
  expect(calls[0][3].get("id")).toBe(calls[1][3].get("id"));
  expect(calls[0][3].get("expected_attempt")).toBe("0");
});
it("blocks an obsolete answer until explicit refresh", async () => {
  vi.mocked(taskApi.submit).mockRejectedValue(new ApiError(409, "TASK_STALE"));
  mount();
  await answer();
  await screen.findByText(tm.stale);
  expect(screen.getByRole("button", { name: tm.submit })).toBeDisabled();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  try {
    fireEvent.click(screen.getByRole("button", { name: tm.refresh }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: tm.submit })).toBeEnabled(),
    );
    expect(screen.getByLabelText(tm.answer)).toHaveValue("");
  } finally {
    confirm.mockRestore();
  }
});
it("closes a saved answer even when the following reload fails", async () => {
  mount();
  await screen.findByLabelText(tm.answer);
  vi.mocked(taskApi.get).mockRejectedValue(
    new ApiError(503, "SERVICE_UNAVAILABLE"),
  );
  await answer();
  await screen.findByText(tm.saved);
  expect(screen.queryByLabelText(tm.answer)).not.toBeInTheDocument();
  expect(taskApi.submit).toHaveBeenCalledTimes(1);
});
it("allows resubmission only after a return and shows the feedback", async () => {
  vi.mocked(taskApi.get).mockResolvedValue({
    ...base,
    attempts: [{ ...returned, reviews: [returned.review!] }],
  });
  mount();
  await screen.findByText("Add a question");
  await answer();
  await waitFor(() => expect(taskApi.submit).toHaveBeenCalledOnce());
  expect(
    vi.mocked(taskApi.submit).mock.calls[0][3].get("expected_attempt"),
  ).toBe("1");
});
it("shows a pending submission without another submit form", async () => {
  vi.mocked(taskApi.get).mockResolvedValue({ ...base, attempts: [submission] });
  mount();
  await screen.findByText(tm.submitted);
  expect(screen.queryByLabelText(tm.answer)).not.toBeInTheDocument();
});
it("offers a fresh response after task conditions change and preserves the old snapshot", async () => {
  vi.mocked(taskApi.get).mockResolvedValue({
    ...base,
    task: {
      ...base.task,
      title: "Updated task",
      instructions: "Use the new prompt.",
      revision: 2,
    },
    attempts: [
      {
        ...submission,
        task_revision: 1,
        conditions: { ...base.task, revision: 1 },
      },
    ],
  });
  mount();
  await screen.findByText(tm.updatedTerms);
  fireEvent.click(screen.getByText(tm.conditionsAtSubmission));
  expect(screen.getByText("Write a dialogue.")).toBeVisible();
  await answer();
  await waitFor(() => expect(taskApi.submit).toHaveBeenCalledOnce());
  expect(
    vi.mocked(taskApi.submit).mock.calls[0][3].get("expected_attempt"),
  ).toBe("1");
});
it("shows a real zero independently of the ungraded state", async () => {
  vi.mocked(taskApi.get).mockResolvedValue({
    ...base,
    attempts: [
      {
        ...submission,
        review: {
          revision: 1,
          outcome: "graded",
          grade: 0,
          feedback: "",
          created_at: "2026-11-06T11:00:00Z",
        },
      },
    ],
  });
  mount();
  await screen.findByText(tm.graded + ": 0");
  expect(screen.queryByText(tm.submitted)).not.toBeInTheDocument();
  expect(screen.queryByLabelText(tm.answer)).not.toBeInTheDocument();
});
it.each([401, 403])(
  "clears an answer when PDF access is rejected (%s)",
  async (status) => {
    vi.mocked(taskApi.get).mockResolvedValue({
      ...base,
      attempts: [{ ...submission, kind: "pdf", text: null }],
    });
    vi.mocked(taskApi.pdf).mockRejectedValue(
      new ApiError(status, "ACCESS_DENIED"),
    );
    const { onDenied } = mount();
    fireEvent.click(await screen.findByRole("button", { name: tm.download }));
    await waitFor(() => expect(onDenied).toHaveBeenCalledOnce());
    expect(screen.queryByText("Greetings task")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: tm.download }),
    ).not.toBeInTheDocument();
  },
);
it("saves an initial teacher grade of zero", async () => {
  await teacher();
  fireEvent.change(screen.getByLabelText(tm.grade), { target: { value: "0" } });
  fireEvent.click(screen.getByRole("button", { name: tm.save }));
  await waitFor(() => expect(taskApi.review).toHaveBeenCalledOnce());
  expect(vi.mocked(taskApi.review).mock.calls[0][4]).toMatchObject({
    grade: 0,
    expected_revision: 0,
    outcome: "graded",
  });
});
it("requires a reason for a correction and keeps it on failure", async () => {
  vi.mocked(taskApi.review).mockRejectedValue(new ApiError(0, "network_error"));
  await teacher(true);
  fireEvent.change(screen.getByLabelText(tm.grade), {
    target: { value: "85" },
  });
  fireEvent.submit(screen.getByLabelText(tm.grade).closest("form")!);
  await screen.findByText(tm.required);
  expect(taskApi.review).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText(tm.reason), {
    target: { value: "Rechecked" },
  });
  fireEvent.click(screen.getByRole("button", { name: tm.save }));
  await screen.findByText(tm.error);
  expect(screen.getByLabelText(tm.grade)).toHaveValue(85);
  expect(screen.getByLabelText(tm.reason)).toHaveValue("Rechecked");
});
it("returns a response with feedback and no grade", async () => {
  await teacher();
  fireEvent.change(screen.getByLabelText(tm.outcome), {
    target: { value: "returned" },
  });
  fireEvent.change(screen.getByLabelText(tm.feedback), {
    target: { value: "Add examples" },
  });
  fireEvent.click(screen.getByRole("button", { name: tm.save }));
  await waitFor(() => expect(taskApi.review).toHaveBeenCalledOnce());
  expect(vi.mocked(taskApi.review).mock.calls[0][4]).toMatchObject({
    outcome: "returned",
    grade: null,
    feedback: "Add examples",
  });
});
it("ignores a response that completes after unmounting", async () => {
  let resolve!: (value: TaskDetails) => void;
  vi.mocked(taskApi.get).mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const { unmount, onDirtyChange } = mount();
  unmount();
  await act(async () => resolve(base));
  expect(onDirtyChange).toHaveBeenCalledTimes(1);
});
it("validates a whitespace-only task without issuing a create", async () => {
  const onSave = vi.fn();
  render(
    <TaskCreateForm
      topic="topic"
      timezone="Asia/Qyzylorda"
      busy={false}
      dirty={vi.fn()}
      save={async (op) => {
        await op();
      }}
      onSave={onSave}
      cancel={vi.fn()}
    />,
  );
  fireEvent.change(screen.getByLabelText(tm.title), { target: { value: " " } });
  fireEvent.change(screen.getByLabelText(tm.instructions), {
    target: { value: " " },
  });
  fireEvent.click(screen.getByRole("button", { name: tm.save }));
  await screen.findByText(tm.required);
  expect(onSave).not.toHaveBeenCalled();
});
