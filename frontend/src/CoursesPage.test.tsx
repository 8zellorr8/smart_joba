import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { CoursesPage } from "./CoursesPage";
import { courseApi } from "./course-api";
import type { Course, CourseContents } from "./course-api";
import { ApiError } from "./api";

vi.mock("./course-api", () => ({
  courseApi: {
    list: vi.fn(),
    contents: vi.fn(),
    open: vi.fn(),
    addTopic: vi.fn(),
    addMaterial: vi.fn(),
    read: vi.fn(),
    download: vi.fn(),
  },
}));
const course: Course = {
  id: "course",
  subject: "English",
  group: "101-А",
  academic_year: "2026–2027",
  semester: 1,
  data_kind: "synthetic",
  opened: true,
  can_manage: true,
};
const detail: CourseContents = {
  course,
  topics: [
    {
      id: "topic-1",
      title: "Greetings",
      week_number: 1,
      materials: [
        { id: "text", title: "Reading", kind: "text" },
        { id: "pdf", title: "Handout", kind: "pdf" },
      ],
    },
  ],
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(courseApi.list).mockResolvedValue([structuredClone(course)]);
  vi.mocked(courseApi.contents).mockResolvedValue(structuredClone(detail));
});
function mount(scope = "scope") {
  const onExpired = vi.fn();
  return {
    ...render(
      <CoursesPage scope={scope} csrfToken="csrf" onExpired={onExpired} />,
    ),
    onExpired,
  };
}
async function enter() {
  fireEvent.click(await screen.findByRole("button", { name: "Курсқа кіру" }));
  await screen.findByRole("button", { name: "Курстарға оралу" });
}
async function topicForm() {
  await enter();
  fireEvent.click(screen.getByRole("button", { name: "Тақырып қосу" }));
  fireEvent.change(screen.getByLabelText("Тақырып атауы"), {
    target: { value: "New topic" },
  });
}
const save = () =>
  fireEvent.click(screen.getByRole("button", { name: "Сақтау" }));

it("filters only authorized courses by subject or group and can clear no matches", async () => {
  vi.mocked(courseApi.list).mockResolvedValue([
    structuredClone(course),
    { ...course, id: "second", subject: "Математика", group: "102-Б" },
  ]);
  mount();
  await screen.findByRole("heading", { name: /Математика/ });
  const search = screen.getByRole("searchbox", { name: "Курстарды іздеу" });
  fireEvent.change(search, { target: { value: "102-Б" } });
  expect(screen.getAllByRole("button", { name: "Курсқа кіру" })).toHaveLength(
    1,
  );
  expect(
    screen.queryByRole("heading", { name: /English/ }),
  ).not.toBeInTheDocument();
  fireEvent.change(search, { target: { value: "жоқ" } });
  expect(screen.getByText("Іздеу бойынша курс табылмады.")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Іздеуді тазалау" }));
  expect(screen.getAllByRole("button", { name: "Курсқа кіру" })).toHaveLength(
    2,
  );
  expect(courseApi.list).toHaveBeenCalledTimes(1);
});

it("shows only read actions to a student and renders material as plain text", async () => {
  vi.mocked(courseApi.contents).mockResolvedValue({
    ...detail,
    course: { ...course, can_manage: false },
  });
  vi.mocked(courseApi.read).mockResolvedValue({
    title: "Reading",
    text: "<script>hello</script>",
  });
  const { container } = mount();
  await enter();
  expect(screen.getByRole("button", { name: /^1-апта/ })).toBeVisible();
  expect(screen.getByRole("button", { name: /^10-апта/ })).toBeVisible();
  expect(screen.getByRole("button", { name: "Жалпы материалдар" })).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Тақырып қосу" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Материал қосу" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Reading · Мәтін" }));
  expect(await screen.findByText("<script>hello</script>")).toBeVisible();
  expect(container.querySelector("script")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Reading · Мәтін" }));
  expect(screen.queryByText("<script>hello</script>")).not.toBeInTheDocument();
});
it("stores a new topic in the selected week and keeps general topics separate", async () => {
  vi.mocked(courseApi.contents).mockResolvedValue({
    course,
    topics: [
      { ...detail.topics[0], week_number: null },
      { ...detail.topics[0], id: "topic-2", title: "Week 3", week_number: 3 },
    ],
  });
  mount();
  await enter();
  expect(screen.getByText("Бұл аптада тақырыптар әзірге жоқ.")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /3-апта/ }));
  expect(screen.getByText("Week 3")).toBeVisible();
  expect(screen.queryByText("Greetings")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Жалпы материалдар" }));
  expect(screen.getByText("Greetings")).toBeVisible();
  expect(screen.queryByText("Week 3")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /^3-апта/ }));
  fireEvent.click(screen.getByRole("button", { name: "Тақырып қосу" }));
  fireEvent.change(screen.getByLabelText("Тақырып атауы"), { target: { value: "New topic" } });
  save();
  await waitFor(() => expect(courseApi.addTopic).toHaveBeenCalledTimes(1));
  expect(vi.mocked(courseApi.addTopic).mock.calls[0][5]).toBe(3);
  expect(screen.getByRole("heading", { name: "3-апта" })).toBeVisible();
});
it("opens an assigned course before requesting its contents", async () => {
  vi.mocked(courseApi.list).mockResolvedValue([{ ...course, opened: false }]);
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Курс құру" }));
  await screen.findByText("Greetings");
  expect(courseApi.open).toHaveBeenCalledWith("scope", "course", "csrf");
  expect(vi.mocked(courseApi.open).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(courseApi.contents).mock.invocationCallOrder[0],
  );
});
it("distinguishes loading failure from an empty list and supports retry", async () => {
  vi.mocked(courseApi.list)
    .mockRejectedValueOnce(new ApiError(0, "network_error"))
    .mockResolvedValueOnce([]);
  mount();
  await screen.findByRole("alert");
  expect(
    screen.queryByText("Сізге қолжетімді курстар әзірге жоқ."),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Қайта жүктеу" }));
  await screen.findByText("Сізге қолжетімді курстар әзірге жоқ.");
});
it("keeps the entered title and operation ID when a save must be retried", async () => {
  vi.mocked(courseApi.addTopic)
    .mockRejectedValueOnce(new ApiError(0, "network_error"))
    .mockResolvedValueOnce({});
  mount();
  await topicForm();
  save();
  await screen.findByRole("alert");
  expect(screen.getByLabelText("Тақырып атауы")).toHaveValue("New topic");
  save();
  await screen.findByText("Сақталды.");
  const calls = vi.mocked(courseApi.addTopic).mock.calls;
  expect(calls[0]).toEqual(calls[1]);
  expect(screen.queryByLabelText("Тақырып атауы")).not.toBeInTheDocument();
});
it("creates a new operation ID when the user changes a rejected input", async () => {
  vi.mocked(courseApi.addTopic).mockRejectedValue(
    new ApiError(409, "COURSE_OPERATION_CONFLICT"),
  );
  mount();
  await topicForm();
  save();
  await screen.findByRole("alert");
  fireEvent.change(screen.getByLabelText("Тақырып атауы"), {
    target: { value: "Changed" },
  });
  save();
  await waitFor(() => expect(courseApi.addTopic).toHaveBeenCalledTimes(2));
  const calls = vi.mocked(courseApi.addTopic).mock.calls;
  expect(calls[0][2]).not.toEqual(calls[1][2]);
});
it("does not invite another save after the write succeeded but refresh failed", async () => {
  mount();
  await topicForm();
  vi.mocked(courseApi.contents).mockRejectedValueOnce(
    new ApiError(503, "SERVICE_UNAVAILABLE"),
  );
  save();
  await screen.findByText(
    "Сақталды, бірақ тізім жаңартылмады. Қайта жүктеңіз.",
  );
  expect(
    screen.queryByRole("button", { name: "Сақтау" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Қайта жүктеу" }));
  await waitFor(() =>
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
  );
  expect(courseApi.addTopic).toHaveBeenCalledTimes(1);
});
it.each([401, 403])(
  "clears private contents on a PDF download denial (%s)",
  async (status) => {
    vi.mocked(courseApi.download).mockRejectedValue(
      new ApiError(status, "ACCESS_DENIED"),
    );
    const { onExpired } = mount();
    await enter();
    fireEvent.click(
      screen.getByRole("button", { name: "Handout · PDF жүктеу" }),
    );
    await screen.findByText("Курсты көруге рұқсат жоқ.");
    expect(screen.queryByText("Greetings")).not.toBeInTheDocument();
    expect(screen.queryByText("Handout")).not.toBeInTheDocument();
    expect(onExpired).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
  },
);
it("does not show a late response after changing the scope", async () => {
  let resolve!: (value: CourseContents) => void;
  vi.mocked(courseApi.contents).mockReturnValueOnce(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const { rerender, onExpired } = mount();
  fireEvent.click(await screen.findByRole("button", { name: "Курсқа кіру" }));
  vi.mocked(courseApi.list).mockResolvedValue([]);
  rerender(
    <CoursesPage scope="other" csrfToken="other" onExpired={onExpired} />,
  );
  await screen.findByText("Сізге қолжетімді курстар әзірге жоқ.");
  await act(async () => resolve(detail));
  expect(screen.queryByText("Greetings")).not.toBeInTheDocument();
});
it("keeps material fields after a rejected upload and sends only the selected format", async () => {
  vi.mocked(courseApi.addMaterial).mockRejectedValueOnce(
    new ApiError(422, "COURSE_PDF_INVALID"),
  );
  mount();
  await enter();
  fireEvent.click(screen.getByRole("button", { name: "Материал қосу" }));
  fireEvent.change(screen.getByLabelText("Материал атауы"), {
    target: { value: "File" },
  });
  fireEvent.change(screen.getByLabelText("Материал түрі"), {
    target: { value: "pdf" },
  });
  const form = screen.getByRole("button", { name: "Сақтау" }).closest("form")!;
  const fd = new FormData();
  fd.set("title", "File");
  fd.set("file", new File(["invalid"], "sample.pdf"));
  // jsdom does not transfer input.files into FormData; supply the browser payload.
  const original = globalThis.FormData;
  const mock = vi.spyOn(globalThis, "FormData").mockImplementation(function (
    input?: HTMLFormElement,
  ) {
    return input === form ? fd : new original(input);
  });
  try {
    fireEvent.submit(form);
    await screen.findByText("Файлды PDF пішімінде сақтап, қайта таңдаңыз.");
    expect(screen.getByLabelText("Материал атауы")).toHaveValue("File");
    expect(fd.has("text")).toBe(false);
    expect(courseApi.addMaterial).toHaveBeenCalledWith(
      "scope",
      "course",
      "topic-1",
      fd,
      "csrf",
    );
  } finally {
    mock.mockRestore();
  }
});
