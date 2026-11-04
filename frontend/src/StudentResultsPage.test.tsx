import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { StudentResultsPage } from "./StudentResultsPage";
import { journalApi } from "./journal-api";
import type { StudentResults } from "./journal-api";
import { ApiError } from "./api";
import { sm } from "./locales/student.kk";
import { jm } from "./locales/journal.kk";
import { lm } from "./locales/lesson.kk";

vi.mock("./journal-api", () => ({ journalApi: { results: vi.fn() } }));
const fixture: StudentResults = {
  student: { id: "me", display_name: "Демо студент А", data_kind: "synthetic" },
  memberships: [],
  periods: [{ context_id: "context", semester: 1, academic_year: "2026–2027" }],
  subjects: [{ id: "subject", name: "English" }],
  revision: "revision",
  page: 1,
  has_next: true,
  items: [
    {
      id: "lesson",
      revision: 1,
      date: "2026-09-01",
      start: "08:00",
      end: "09:30",
      timezone: "Asia/Almaty",
      subject: "English",
      group: "101-А",
      academic_year: "2026–2027",
      semester: 1,
      topic: "Past simple",
      grade: 0,
      attendance: "absent",
      active: true,
    },
  ],
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(journalApi.results).mockResolvedValue(structuredClone(fixture));
});
function mount() {
  const expired = vi.fn(),
    schedule = vi.fn();
  render(
    <StudentResultsPage
      scope="scope"
      onExpired={expired}
      onSchedule={schedule}
    />,
  );
  return { expired, schedule };
}

it("shows own zero independently of absence and has no edit controls or totals", async () => {
  const { schedule } = mount();
  await screen.findByText("0", { selector: "dd" });
  expect(screen.getByText(lm.attendanceValues.absent)).toBeInTheDocument();
  expect(screen.getByText("Past simple")).toBeInTheDocument();
  expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
  expect(
    screen.queryByText(/average|итоговый|орташа/i),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: sm.schedule }));
  expect(schedule).toHaveBeenCalledOnce();
});
it("distinguishes null values from zero and labels removed historical rows", async () => {
  vi.mocked(journalApi.results).mockResolvedValue({
    ...fixture,
    items: [
      { ...fixture.items[0], grade: null, attendance: null, active: false },
    ],
  });
  mount();
  await screen.findByText(sm.noGrade);
  expect(screen.getByText(lm.attendanceValues[""])).toBeInTheDocument();
  expect(screen.getByText(sm.removed)).toBeInTheDocument();
  expect(screen.queryByText("0", { selector: "dd" })).not.toBeInTheDocument();
});
it("keeps both filters and the revision on next/previous pages and resets page when filtering", async () => {
  mount();
  await screen.findByText("Past simple");
  fireEvent.change(screen.getByLabelText(sm.period), {
    target: { value: "context:1" },
  });
  await waitFor(() =>
    expect(journalApi.results).toHaveBeenLastCalledWith("scope", {
      context_id: "context",
      semester: 1,
      subject_id: undefined,
    }),
  );
  await screen.findByText("Past simple");
  fireEvent.change(screen.getByLabelText(sm.subject), {
    target: { value: "subject" },
  });
  await screen.findByText("Past simple");
  vi.mocked(journalApi.results).mockResolvedValue({
    ...fixture,
    page: 2,
    has_next: false,
    items: [{ ...fixture.items[0], topic: "Second page" }],
  });
  fireEvent.click(screen.getByRole("button", { name: sm.next }));
  await screen.findByText("Second page");
  expect(journalApi.results).toHaveBeenLastCalledWith("scope", {
    context_id: "context",
    semester: 1,
    subject_id: "subject",
    page: 2,
    revision: "revision",
  });
  expect(
    screen.getByRole("heading", { name: `${sm.results} · ${sm.page} 2` }),
  ).toHaveFocus();
  expect(screen.getByLabelText(sm.subject)).toHaveValue("subject");
  fireEvent.click(screen.getByRole("button", { name: sm.previous }));
  await waitFor(() =>
    expect(journalApi.results).toHaveBeenLastCalledWith("scope", {
      context_id: "context",
      semester: 1,
      subject_id: "subject",
      page: 1,
      revision: "revision",
    }),
  );
  fireEvent.change(screen.getByLabelText(sm.subject), {
    target: { value: "" },
  });
  await waitFor(() =>
    expect(journalApi.results).toHaveBeenLastCalledWith("scope", {
      context_id: "context",
      semester: 1,
      subject_id: undefined,
    }),
  );
});
it("shows loading and an honest empty result separately", async () => {
  let resolve!: (value: StudentResults) => void;
  vi.mocked(journalApi.results).mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  mount();
  expect(screen.getByText(jm.loading)).toBeInTheDocument();
  expect(screen.queryByText(sm.empty)).not.toBeInTheDocument();
  resolve({ ...fixture, items: [], has_next: false });
  await screen.findByText(sm.empty);
  expect(screen.queryByText(jm.loading)).not.toBeInTheDocument();
});
it("network error clears rows, retains filters and retries the same page", async () => {
  mount();
  await screen.findByText("Past simple");
  vi.mocked(journalApi.results).mockRejectedValueOnce(
    new ApiError(0, "network_error"),
  );
  fireEvent.click(screen.getByRole("button", { name: sm.next }));
  await screen.findByRole("alert");
  expect(screen.queryByText("Past simple")).not.toBeInTheDocument();
  expect(screen.queryByText(sm.empty)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: jm.retry }));
  await screen.findByText("Past simple");
  expect(journalApi.results).toHaveBeenLastCalledWith(
    "scope",
    expect.objectContaining({ page: 2, revision: "revision" }),
  );
});
it("stale response requires refresh of page one without losing filters", async () => {
  mount();
  await screen.findByText("Past simple");
  fireEvent.change(screen.getByLabelText(sm.subject), {
    target: { value: "subject" },
  });
  await screen.findByText("Past simple");
  vi.mocked(journalApi.results).mockRejectedValueOnce(
    new ApiError(409, "JOURNAL_RESULTS_STALE"),
  );
  fireEvent.click(screen.getByRole("button", { name: sm.next }));
  await screen.findByText(sm.stale);
  expect(screen.queryByText("Past simple")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: sm.reload }));
  await screen.findByText("Past simple");
  expect(journalApi.results).toHaveBeenLastCalledWith("scope", {
    context_id: undefined,
    semester: undefined,
    subject_id: "subject",
  });
});
it.each([401, 403])(
  "clears identity, filters and rows on %s",
  async (status) => {
    const { expired } = mount();
    await screen.findByText("Past simple");
    vi.mocked(journalApi.results).mockRejectedValue(
      new ApiError(status, "ACCESS_DENIED"),
    );
    fireEvent.click(screen.getByRole("button", { name: sm.refresh }));
    await screen.findByText(jm.denied);
    expect(screen.queryByText("Past simple")).not.toBeInTheDocument();
    expect(screen.queryByText("Демо студент А")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(sm.subject)).not.toBeInTheDocument();
    expect(expired).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
  },
);
it("can recover with all filters cleared after the personal binding changes", async () => {
  mount();
  await screen.findByText("Past simple");
  fireEvent.change(screen.getByLabelText(sm.subject), {
    target: { value: "subject" },
  });
  await screen.findByText("Past simple");
  vi.mocked(journalApi.results).mockRejectedValueOnce(
    new ApiError(403, "ACCESS_DENIED"),
  );
  fireEvent.click(screen.getByRole("button", { name: sm.refresh }));
  await screen.findByText(jm.denied);
  vi.mocked(journalApi.results).mockResolvedValue({
    ...fixture,
    subjects: [],
    items: [],
  });
  fireEvent.click(screen.getByRole("button", { name: jm.retry }));
  await screen.findByText(sm.empty);
  expect(journalApi.results).toHaveBeenLastCalledWith("scope", {});
});
it("ignores an older request after changing filters", async () => {
  mount();
  await screen.findByText("Past simple");
  let resolve!: (value: StudentResults) => void;
  vi.mocked(journalApi.results).mockReturnValueOnce(
    new Promise((r) => {
      resolve = r;
    }),
  );
  fireEvent.change(screen.getByLabelText(sm.subject), {
    target: { value: "subject" },
  });
  await waitFor(() => expect(journalApi.results).toHaveBeenCalledTimes(2));
  fireEvent.change(screen.getByLabelText(sm.subject), {
    target: { value: "" },
  });
  await screen.findByText("Past simple");
  resolve({
    ...fixture,
    items: [{ ...fixture.items[0], topic: "Old private response" }],
  });
  await waitFor(() =>
    expect(screen.queryByText("Old private response")).not.toBeInTheDocument(),
  );
});
it("scope change drops old personal data and ignores its pending request", async () => {
  let resolve!: (value: StudentResults) => void;
  vi.mocked(journalApi.results).mockReturnValueOnce(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const view = render(<StudentResultsPage scope="old" onExpired={vi.fn()} />);
  vi.mocked(journalApi.results).mockResolvedValue({
    ...fixture,
    student: { ...fixture.student, display_name: "New student" },
    items: [],
  });
  view.rerender(<StudentResultsPage scope="new" onExpired={vi.fn()} />);
  await screen.findByText("New student", { selector: "strong" });
  resolve(fixture);
  await waitFor(() =>
    expect(screen.queryByText("Past simple")).not.toBeInTheDocument(),
  );
});
it("renders a saved topic as text rather than markup", async () => {
  vi.mocked(journalApi.results).mockResolvedValue({
    ...fixture,
    items: [{ ...fixture.items[0], topic: '<img src=x onerror="alert(1)">' }],
  });
  mount();
  await screen.findByText('<img src=x onerror="alert(1)">');
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
});
