import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { JournalSetupPage } from "./JournalSetupPage";
import { JournalReadPage } from "./JournalReadPage";
import { journalApi } from "./journal-api";
import type { SetupData } from "./journal-api";
import { ApiError } from "./api";
import { jm } from "./locales/journal.kk";

vi.mock("./journal-api", () => ({
  journalApi: {
    setup: vi.fn(),
    command: vi.fn(),
    journals: vi.fn(),
    roster: vi.fn(),
    me: vi.fn(),
  },
}));
const fixture: SetupData = {
  revision: 4,
  students: [
    { id: "student-a", display_name: "Демо студент А", data_kind: "synthetic" },
  ],
  memberships: [],
  bindings: [],
  contexts: [
    { id: "context", academic_year: "2026-2027", data_kind: "synthetic" },
  ],
  groups: [{ id: "group", code: "TEST-EDITOR-A", data_kind: "synthetic" }],
  teachers: [
    {
      id: "teacher",
      display_name: "SYNTHETIC Editor Teacher A",
      data_kind: "synthetic",
    },
  ],
  accounts: [
    {
      id: "account",
      display_name: "Демо аккаунт",
      email: "demo@example.test",
      group_id: "group",
    },
  ],
  demands: [
    {
      id: "demand",
      context_id: "context",
      group_id: "group",
      subject: "SYNTHETIC Subject 0",
      semester: 1,
    },
  ],
  journals: [
    {
      id: "journal",
      subject: "SYNTHETIC Subject 0",
      group: "TEST-EDITOR-A",
      academic_year: "2026-2027",
      semester: 1,
      data_kind: "synthetic",
      periods: [{ start: "2026-09-01", end: "2027-07-01" }],
    },
  ],
  assignments: [],
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(journalApi.setup).mockResolvedValue(structuredClone(fixture));
  vi.mocked(journalApi.command).mockResolvedValue({
    id: "student-new",
    revision: 5,
    kind: "create_student",
  });
  vi.mocked(journalApi.journals).mockResolvedValue({
    revision: 4,
    journals: structuredClone(fixture.journals),
  });
  vi.mocked(journalApi.roster).mockResolvedValue({
    journal_id: "journal",
    date: "2026-09-02",
    revision: 4,
    is_snapshot: false,
    students: [{ id: "student-a", display_name: "Демо студент А" }],
  });
});
async function setup() {
  const expired = vi.fn();
  const dirty = vi.fn();
  render(
    <JournalSetupPage
      scope="scope"
      csrfToken="csrf"
      onExpired={expired}
      onDirtyChange={dirty}
    />,
  );
  await screen.findByLabelText(jm.name);
  return { expired, dirty };
}
function fillStudent() {
  fireEvent.change(screen.getByLabelText(jm.name), {
    target: { value: "Демо студент Б" },
  });
  fireEvent.change(screen.getByLabelText(jm.kind), {
    target: { value: "synthetic" },
  });
  fireEvent.click(screen.getByRole("button", { name: jm.save }));
}
it("sends an explicit kind, revision and operation key and shows server success", async () => {
  const { dirty } = await setup();
  fillStudent();
  await screen.findByText(jm.saved);
  expect(journalApi.command).toHaveBeenCalledWith("scope", "csrf", {
    expected_revision: 4,
    operation_id: expect.any(String),
    command: {
      kind: "create_student",
      display_name: "Демо студент Б",
      data_kind: "synthetic",
    },
  });
  expect(dirty).toHaveBeenCalledWith(true);
  expect(dirty).toHaveBeenLastCalledWith(false);
});
it("retains input and focuses the linked validation error", async () => {
  vi.mocked(journalApi.command).mockRejectedValue(
    new ApiError(422, "JOURNAL_REQUIRED", { field: "display_name" }),
  );
  await setup();
  fillStudent();
  await screen.findByRole("alert");
  expect(screen.getByLabelText(jm.name)).toHaveValue("Демо студент Б");
  expect(screen.getByLabelText(jm.name)).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await waitFor(() => expect(screen.getByRole("alert")).toHaveFocus());
  expect(screen.queryByText(jm.saved)).not.toBeInTheDocument();
});
it("blocks a stale form until an explicit reload decision", async () => {
  vi.mocked(journalApi.command).mockRejectedValue(
    new ApiError(409, "JOURNAL_STALE"),
  );
  await setup();
  fillStudent();
  await screen.findByText(jm.stale);
  expect(screen.getByLabelText(jm.name)).toHaveValue("Демо студент Б");
  expect(screen.getByRole("button", { name: jm.save })).toBeDisabled();
  vi.spyOn(window, "confirm").mockReturnValue(false);
  fireEvent.click(screen.getByRole("button", { name: jm.retry }));
  expect(screen.getByLabelText(jm.name)).toHaveValue("Демо студент Б");
});
it("retries an unknown outcome with exactly the same operation and body", async () => {
  vi.mocked(journalApi.command)
    .mockRejectedValueOnce(new ApiError(0, "network_error"))
    .mockResolvedValueOnce({
      id: "student-new",
      revision: 5,
      kind: "create_student",
    });
  await setup();
  fillStudent();
  await screen.findByText(jm.uncertain);
  expect(screen.getByLabelText(jm.name)).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: jm.retrySave }));
  await screen.findByText(jm.saved);
  const calls = vi.mocked(journalApi.command).mock.calls;
  expect(calls[0]).toEqual(calls[1]);
});
it("clears closed data after forbidden save", async () => {
  vi.mocked(journalApi.command).mockRejectedValue(
    new ApiError(403, "ACCESS_DENIED"),
  );
  await setup();
  fillStudent();
  await screen.findByText(jm.denied);
  expect(screen.queryByText("Демо студент А")).not.toBeInTheDocument();
  expect(screen.queryByLabelText(jm.name)).not.toBeInTheDocument();
});
it("a load failure is an error and not an empty student roster", async () => {
  vi.mocked(journalApi.setup).mockRejectedValue(
    new ApiError(503, "SERVICE_UNAVAILABLE"),
  );
  render(
    <JournalSetupPage
      scope="scope"
      csrfToken="csrf"
      onExpired={vi.fn()}
      onDirtyChange={vi.fn()}
    />,
  );
  await screen.findByText(jm.loadError);
  expect(screen.queryByText(jm.emptyStudents)).not.toBeInTheDocument();
});
it("uses the selected stable student ID for rename", async () => {
  await setup();
  fireEvent.click(screen.getByRole("button", { name: jm.edit }));
  fireEvent.change(screen.getByLabelText(jm.name), {
    target: { value: "Демо жаңартылды" },
  });
  fireEvent.change(screen.getByLabelText(jm.reason), {
    target: { value: "Test correction" },
  });
  fireEvent.click(screen.getByRole("button", { name: jm.save }));
  await waitFor(() => expect(journalApi.command).toHaveBeenCalled());
  expect(vi.mocked(journalApi.command).mock.calls[0][2].command).toEqual({
    kind: "rename_student",
    student_id: "student-a",
    display_name: "Демо жаңартылды",
    reason: "Test correction",
  });
});
it("shows only the roster returned for the chosen journal and date", async () => {
  render(
    <JournalReadPage scope="scope" personal={false} onExpired={vi.fn()} />,
  );
  fireEvent.click(await screen.findByRole("button", { name: jm.openRoster }));
  fireEvent.change(screen.getByLabelText(jm.date), {
    target: { value: "2026-09-02" },
  });
  fireEvent.click(screen.getByRole("button", { name: jm.show }));
  await screen.findByText("Демо студент А");
  expect(journalApi.roster).toHaveBeenCalledWith(
    "scope",
    "journal",
    "2026-09-02",
  );
  expect(screen.getByText(jm.preview)).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: jm.save }),
  ).not.toBeInTheDocument();
});
it("discards a late roster response after changing the date", async () => {
  let resolve!: (value: Awaited<ReturnType<typeof journalApi.roster>>) => void;
  vi.mocked(journalApi.roster).mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  render(
    <JournalReadPage scope="scope" personal={false} onExpired={vi.fn()} />,
  );
  fireEvent.click(await screen.findByRole("button", { name: jm.openRoster }));
  fireEvent.change(screen.getByLabelText(jm.date), {
    target: { value: "2026-09-02" },
  });
  fireEvent.click(screen.getByRole("button", { name: jm.show }));
  fireEvent.change(screen.getByLabelText(jm.date), {
    target: { value: "2026-09-03" },
  });
  resolve({
    journal_id: "journal",
    date: "2026-09-02",
    revision: 4,
    is_snapshot: false,
    students: [{ id: "old", display_name: "Old private name" }],
  });
  await waitFor(() =>
    expect(screen.getByLabelText(jm.date)).toHaveValue("2026-09-03"),
  );
  expect(screen.queryByText("Old private name")).not.toBeInTheDocument();
});
it("shows a missing personal binding as access denial", async () => {
  vi.mocked(journalApi.me).mockRejectedValue(
    new ApiError(403, "ACCESS_DENIED"),
  );
  render(<JournalReadPage scope="scope" personal onExpired={vi.fn()} />);
  await screen.findByText(jm.denied);
  expect(journalApi.journals).not.toHaveBeenCalled();
  expect(screen.queryByText(jm.noMemberships)).not.toBeInTheDocument();
});
it("personal profile asks only for the current account projection", async () => {
  vi.mocked(journalApi.me).mockResolvedValue({
    student: fixture.students[0],
    memberships: [],
  });
  render(<JournalReadPage scope="scope" personal onExpired={vi.fn()} />);
  await screen.findByRole("heading", { name: "Демо студент А" });
  expect(journalApi.me).toHaveBeenCalledWith("scope");
  expect(journalApi.setup).not.toHaveBeenCalled();
});
it("requests a new login when journal reading expires", async () => {
  const expired = vi.fn();
  vi.mocked(journalApi.journals).mockRejectedValue(
    new ApiError(401, "AUTH_REQUIRED"),
  );
  render(
    <JournalReadPage scope="scope" personal={false} onExpired={expired} />,
  );
  await waitFor(() => expect(expired).toHaveBeenCalledOnce());
});
