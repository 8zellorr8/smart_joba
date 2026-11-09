import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkbenchHome } from "./WorkbenchHome";
import { publicationApi, versionApi } from "./publication-api";
import type { PublishedView, VersionSummary } from "./publication-api";
import type { Workspace } from "./api";
import { ApiError } from "./api";
import { wb } from "./locales/workbench.kk";
import { portal } from "./locales/portal.kk";

// The subject projection has separate pagination, privacy and navigation tests.
vi.mock("./SubjectOverview", () => ({ SubjectOverview: () => null }));
vi.mock("./TeacherQueue", () => ({
  TeacherQueue: () => <p>Teacher queue marker</p>,
}));

vi.mock("./publication-api", () => ({
  publicationApi: { list: vi.fn(), get: vi.fn() },
  versionApi: { list: vi.fn() },
}));
const workspace: Workspace = {
  scope: { id: "scope", name: "Тест ортасы", is_demo: true },
  role_codes: ["student"],
  permissions: ["publication.read.group"],
  stage: 6,
};
const publication = (): PublishedView => ({
  publication_id: "pub",
  version_id: "version",
  version_number: 5,
  revision: 1,
  published_at: "2026-10-21T12:00:00Z",
  name: "Кесте",
  context_id: "context",
  academic_year: "2026-2027",
  data_kind: "college",
  semester: 1,
  scope_name: "Тест",
  timezone: "Asia/Almaty",
  is_current: true,
  groups: ["Топ А"],
  event_count: 1,
  external_verified: false,
  events: [
    {
      id: "own",
      date: "2026-10-22",
      start: "09:00",
      end: "10:30",
      subject: "Қазақ тілі",
      group: "Топ А",
      teacher: "Оқытушы А",
      room: "101",
    },
  ],
  total: 1,
  offset: 0,
  limit: 100,
  resources: {
    group: [{ id: "group-a", name: "Топ А" }],
    teacher: [],
    room: [],
  },
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-21T21:30:00Z"));
  vi.mocked(publicationApi.list).mockResolvedValue([publication()]);
  vi.mocked(publicationApi.get).mockResolvedValue(publication());
  vi.mocked(versionApi.list).mockResolvedValue([]);
});
afterEach(() => vi.useRealTimers());
const setup = (props = {}) =>
  render(
    <WorkbenchHome
      workspace={workspace}
      onNavigate={vi.fn()}
      onOpenDraft={vi.fn()}
      onOpenPublication={vi.fn()}
      onExpired={vi.fn()}
      {...props}
    />,
  );

it("shows the review queue only to a teacher with both permissions", () => {
  const callbacks = { onOpenTask: vi.fn(), onOpenLesson: vi.fn() };
  const teacher: Workspace = {
    ...workspace,
    role_codes: ["teacher"],
    permissions: ["course.manage", "journal.write.own"],
  };
  const view = setup({ ...callbacks, workspace: teacher });
  expect(screen.getByText("Teacher queue marker")).toBeInTheDocument();
  view.rerender(
    <WorkbenchHome
      workspace={{ ...teacher, permissions: ["course.manage"] }}
      onNavigate={vi.fn()}
      onOpenDraft={vi.fn()}
      onOpenPublication={vi.fn()}
      onExpired={vi.fn()}
      {...callbacks}
    />,
  );
  expect(screen.queryByText("Teacher queue marker")).not.toBeInTheDocument();
});

it("opens the student's own results and courses through the home shortcuts", async () => {
  const navigate = vi.fn();
  setup({
    workspace: {
      ...workspace,
      permissions: [...workspace.permissions, "course.read"],
    },
    onNavigate: navigate,
    onOpenJournalDate: vi.fn(),
  });
  fireEvent.click(
    screen.getByRole("button", { name: new RegExp(portal.resultsHint) }),
  );
  expect(navigate).toHaveBeenLastCalledWith("study-profile");
  fireEvent.click(
    screen.getByRole("button", { name: new RegExp(portal.coursesHint) }),
  );
  expect(navigate).toHaveBeenLastCalledWith("courses");
  expect(
    screen.queryByRole("button", { name: new RegExp(portal.journalsHint) }),
  ).not.toBeInTheDocument();
  await screen.findByText("Қазақ тілі");
  expect(
    screen.queryByRole("button", { name: /^Журналдар$/ }),
  ).not.toBeInTheDocument();
});

it("keeps courses and student results out of the administrator's shortcuts", async () => {
  const navigate = vi.fn();
  setup({
    workspace: {
      ...workspace,
      role_codes: ["admin"],
      permissions: ["journal.setup"],
    },
    onNavigate: navigate,
  });
  fireEvent.click(
    screen.getByRole("button", { name: new RegExp(portal.studentsHint) }),
  );
  expect(navigate).toHaveBeenCalledWith("journal-setup");
  expect(
    screen.queryByRole("button", { name: new RegExp(portal.coursesHint) }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: new RegExp(portal.resultsHint) }),
  ).not.toBeInTheDocument();
});

it("uses the publication timezone for today's agenda and only requests the reader API", async () => {
  const open = vi.fn();
  setup({ onOpenPublication: open });
  expect(await screen.findByText("Қазақ тілі")).toBeVisible();
  expect(screen.getByText("Бейсенбі, 22 қазан")).toBeVisible();
  expect(publicationApi.get).toHaveBeenCalledWith(
    "pub",
    expect.objectContaining({ start: "2026-10-22", end: "2026-10-22" }),
  );
  expect(versionApi.list).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("button", { name: wb.openDraft }),
  ).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: wb.openWeek }));
  expect(open).toHaveBeenCalledWith("pub", "2026-10-22", "");
});
it("opens a teacher's journals with the selected agenda date", async () => {
  const openJournalDate = vi.fn();
  setup({
    workspace: {
      ...workspace,
      role_codes: ["teacher"],
      permissions: ["publication.read.own", "journal.read.own"],
    },
    onOpenJournalDate: openJournalDate,
  });
  await screen.findByText("Қазақ тілі");
  fireEvent.click(screen.getByRole("button", { name: /^Журналдар$/ }));
  expect(openJournalDate).toHaveBeenCalledWith("2026-10-22");
});
it("shows an empty agenda only after the server confirms zero lessons", async () => {
  vi.mocked(publicationApi.get).mockResolvedValue({
    ...publication(),
    events: [],
    total: 0,
  });
  setup();
  expect(await screen.findByText(wb.noLessons)).toBeVisible();
  expect(screen.queryByText("Қазақ тілі")).not.toBeInTheDocument();
});
it("does not replace a failed request with a no-lessons success state", async () => {
  vi.mocked(publicationApi.get).mockRejectedValue(
    new ApiError(0, "network_error"),
  );
  setup();
  await screen.findByRole("alert");
  expect(screen.queryByText(wb.noLessons)).not.toBeInTheDocument();
});
it("preserves scope and group IDs when changing the agenda date and group", async () => {
  setup();
  await screen.findByText("Қазақ тілі");
  await userEvent.selectOptions(
    screen.getByLabelText("Күннің тобы"),
    "group-a",
  );
  await waitFor(() =>
    expect(publicationApi.get).toHaveBeenLastCalledWith(
      "pub",
      expect.objectContaining({ resource_id: "group-a" }),
    ),
  );
  await waitFor(() => expect(screen.getByLabelText(wb.date)).toBeEnabled());
  fireEvent.change(screen.getByLabelText(wb.date), {
    target: { value: "2026-10-29" },
  });
  await waitFor(() =>
    expect(publicationApi.get).toHaveBeenLastCalledWith("pub", {
      start: "2026-10-29",
      end: "2026-10-29",
      view: "group",
      resource_id: "group-a",
      offset: 0,
    }),
  );
});
it("does not fetch drafts or publications without their server-provided permissions", () => {
  setup({
    workspace: { ...workspace, permissions: [], role_codes: ["admin"] },
  });
  expect(versionApi.list).not.toHaveBeenCalled();
  expect(publicationApi.list).not.toHaveBeenCalled();
  expect(publicationApi.get).not.toHaveBeenCalled();
});
it("opens the exact permitted draft, preferring an editable version over a publication", async () => {
  const open = vi.fn();
  const draft = {
    id: "draft-3",
    name: "Үлгі жоба",
    status: "draft",
    version_number: 3,
    revision: 4,
    data_kind: "college",
    academic_year: "2026-2027",
  } as VersionSummary;
  vi.mocked(versionApi.list).mockResolvedValue([
    { ...draft, id: "published", status: "published" },
    draft,
  ]);
  setup({
    workspace: {
      ...workspace,
      permissions: ["draft.read"],
      role_codes: ["approver"],
    },
    onOpenDraft: open,
  });
  await userEvent.click(
    await screen.findByRole("button", { name: wb.openDraft }),
  );
  expect(open).toHaveBeenCalledWith("draft-3");
  expect(publicationApi.list).not.toHaveBeenCalled();
});

it("keeps the chosen date and group when retrying a failed agenda read", async () => {
  const open = vi.fn();
  setup({ onOpenPublication: open });
  await screen.findByText("Қазақ тілі");
  await userEvent.selectOptions(
    screen.getByLabelText("Күннің тобы"),
    "group-a",
  );
  await waitFor(() => expect(screen.getByLabelText(wb.date)).toBeEnabled());
  vi.mocked(publicationApi.get).mockRejectedValueOnce(
    new ApiError(0, "network_error"),
  );
  fireEvent.change(screen.getByLabelText(wb.date), {
    target: { value: "2026-10-29" },
  });
  await screen.findByRole("alert");
  await userEvent.click(screen.getByRole("button", { name: wb.retry }));
  await screen.findByText("Қазақ тілі");
  expect(screen.getByLabelText(wb.date)).toHaveValue("2026-10-29");
  expect(screen.getByLabelText("Күннің тобы")).toHaveValue("group-a");
  await userEvent.click(screen.getByRole("button", { name: wb.openWeek }));
  expect(open).toHaveBeenCalledWith("pub", "2026-10-29", "group-a");
});
