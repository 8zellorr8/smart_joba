import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "./api";
import { EditorPage } from "./EditorPage";
import { editorApi } from "./editor-api";
import type { EditorData, ScheduleDraft } from "./editor-api";
import { emptyCalendar } from "./CalendarPage";
import { em } from "./locales/editor.kk";
import { vm, versionStatuses } from "./locales/publication.kk";

vi.mock("./editor-api", () => ({
  editorApi: {
    data: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    series: vi.fn(),
    one: vi.fn(),
    room: vi.fn(),
  },
}));
vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  api: { session: vi.fn() },
}));
function data(): EditorData {
  return {
    rooms: [
      {
        id: "room",
        code: "TEST-101",
        data_kind: "synthetic",
        exclusive: true,
        confirmed: true,
        source: "SYNTHETIC TEST",
        revision: 1,
      },
    ],
    contexts: [
      {
        id: "context",
        academic_year: "2026-2027",
        data_kind: "synthetic",
        revision: 2,
      },
    ],
    assignments: [
      {
        id: "assignment",
        revision: 1,
        demand_id: "demand",
        context_id: "context",
        group_id: "group",
        group: "TEST-A",
        teacher_id: "teacher",
        teacher: "SYNTHETIC Teacher",
        subject: "SYNTHETIC Subject",
        semester: 1,
      },
    ],
    calendars: [
      {
        id: "calendar",
        context_id: "context",
        group_id: "group",
        revision: 1,
        document: {
          ...emptyCalendar(),
          start: "2026-09-01",
          end: "2026-11-16",
          slots: [
            { id: "first", label: "TEST 90 min", start: "09:00", end: "10:30" },
            { id: "second", label: "TEST next", start: "10:30", end: "12:00" },
          ],
        },
      },
    ],
    drafts: [
      {
        id: "draft",
        context_id: "context",
        name: "SYNTHETIC editor",
        revision: 2,
        status: "draft",
      },
    ],
  };
}
function draft(): ScheduleDraft {
  return {
    id: "draft",
    context_id: "context",
    name: "SYNTHETIC editor",
    academic_year: "2026-2027",
    data_kind: "synthetic",
    revision: 2,
    status: "draft",
    stale: false,
    dependencies: {
      context_revision: 2,
      calendars: { calendar: 1 },
      rooms: { room: 1 },
    },
    occurrences: [
      {
        id: "event",
        series_id: "series",
        base_date: "2026-09-01",
        date: "2026-09-01",
        start: "09:00",
        end: "10:30",
        assignment_id: "assignment",
        assignment_revision: 1,
        demand_id: "demand",
        group_id: "group",
        group: "TEST-A",
        teacher_id: "teacher",
        teacher: "SYNTHETIC Teacher",
        subject: "SYNTHETIC Subject",
        semester: 1,
        calendar_id: "calendar",
        calendar_revision: 1,
        room_id: "room",
        room: "TEST-101",
        room_revision: 1,
        room_exclusive: true,
        cancelled: false,
        pinned: false,
        source_coordinate: "K2",
      },
    ],
    series: [
      {
        id: "series",
        count: 1,
        template: {
          assignment_id: "assignment",
          assignment_revision: 1,
          calendar_id: "calendar",
          calendar_revision: 1,
          room_id: "room",
          room_revision: 1,
          pattern: {
            id: "manual",
            start: "2026-09-01",
            end: "2026-09-01",
            slot_id: "first",
            weekdays: [1],
            dates: [],
            cancelled_dates: [],
          },
        },
      },
    ],
    total: 1,
    offset: 0,
    limit: 100,
    report: {
      revision: 2,
      stale: false,
      has_errors: false,
      conflicts: [],
      conflicts_truncated: false,
      errors: [],
      errors_truncated: false,
      questions: [],
      questions_truncated: false,
      notes: ["EXTERNAL_OCCUPANCY_UNVERIFIED"],
      hours: [],
      actual_registered: false,
    },
  };
}
function setup(canEdit = true, canRead = true, canManageRooms = false) {
  return render(
    <EditorPage
      scope="scope"
      csrfToken="csrf"
      canEdit={canEdit}
      canRead={canRead}
      canManageRooms={canManageRooms}
      onExpired={vi.fn()}
    />,
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(editorApi.data).mockResolvedValue(data());
  vi.mocked(editorApi.get).mockResolvedValue(draft());
});
describe("manual schedule editor", () => {
  it("explains a published version while keeping editing disabled and the exact version link available", async () => {
    const published = { ...draft(), status: "published", version_number: 5 };
    vi.mocked(editorApi.get).mockResolvedValue(published);
    const onOpenVersion = vi.fn();
    render(
      <EditorPage
        scope="scope"
        csrfToken="csrf"
        canEdit
        canRead
        canManageRooms={false}
        onExpired={vi.fn()}
        onOpenVersion={onOpenVersion}
      />,
    );
    expect(await screen.findByText(versionStatuses.published)).toBeVisible();
    expect(screen.getByText(vm.readonly)).toBeVisible();
    expect(
      screen.getByRole("button", { name: em.createSeries }),
    ).toBeDisabled();
    const edit = screen.getByRole("button", {
      name: `${em.oneEdit} · 2026-09-01`,
    });
    expect(edit).toBeDisabled();
    await userEvent.click(edit);
    await userEvent.click(screen.getByRole("button", { name: vm.title }));
    expect(onOpenVersion).toHaveBeenCalledWith("draft");
    expect(editorApi.one).not.toHaveBeenCalled();
    expect(editorApi.series).not.toHaveBeenCalled();
    expect(editorApi.create).not.toHaveBeenCalled();
  });
  it("approver reads the draft without edit or create actions", async () => {
    setup(false);
    await screen.findByRole("table", { name: /SYNTHETIC editor/ });
    expect(
      screen.queryByRole("button", { name: em.createSeries }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: `${em.oneEdit} · 2026-09-01` }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(em.readonly)).toBeVisible();
  });
  it("keeps a filled single-date form after revision conflict", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(
      await screen.findByRole("button", { name: `${em.oneEdit} · 2026-09-01` }),
    );
    await user.clear(screen.getByLabelText(em.date));
    await user.type(screen.getByLabelText(em.date), "2026-09-08");
    vi.mocked(editorApi.one).mockRejectedValue(
      new ApiError(409, "EDITOR_STALE"),
    );
    await user.click(screen.getByRole("button", { name: em.saveOne }));
    expect(await screen.findByRole("alert")).toHaveTextContent(em.stale);
    expect(screen.getByLabelText(em.date)).toHaveValue("2026-09-08");
    expect(screen.queryByText(em.saved)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: em.report }),
    ).not.toBeInTheDocument();
  });
  it("single-date save sends only that occurrence through the one-date command", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(
      await screen.findByRole("button", { name: `${em.oneEdit} · 2026-09-01` }),
    );
    await user.selectOptions(screen.getByLabelText(em.time), "10:30|12:00");
    vi.mocked(editorApi.one).mockResolvedValue({ ...draft(), revision: 3 });
    await user.click(screen.getByRole("button", { name: em.saveOne }));
    await screen.findByText(em.saved);
    expect(editorApi.one).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 2 }),
      expect.objectContaining({ id: "event" }),
      expect.objectContaining({ start: "10:30", end: "12:00" }),
      "csrf",
    );
    expect(editorApi.series).not.toHaveBeenCalled();
  });
  it("failed save retains a pending cancellation without a success notice", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(
      await screen.findByRole("button", { name: `${em.oneEdit} · 2026-09-01` }),
    );
    await user.click(screen.getByLabelText(em.cancelled));
    vi.mocked(editorApi.one).mockRejectedValue(
      new ApiError(503, "SERVICE_UNAVAILABLE"),
    );
    await user.click(screen.getByRole("button", { name: em.saveOne }));
    expect(await screen.findByRole("alert")).toHaveTextContent(em.error);
    expect(screen.getByLabelText(em.cancelled)).toBeChecked();
    expect(screen.queryByText(em.saved)).not.toBeInTheDocument();
  });
  it("does not silently advance an open form to another user's revision when filtering", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(
      await screen.findByRole("button", { name: `${em.oneEdit} · 2026-09-01` }),
    );
    await user.click(screen.getByLabelText(em.pinned));
    vi.mocked(editorApi.get).mockResolvedValue({ ...draft(), revision: 3 });
    await user.click(screen.getByRole("button", { name: em.show }));
    expect(await screen.findByRole("alert")).toHaveTextContent(em.stale);
    expect(screen.getByLabelText(em.pinned)).toBeChecked();
    expect(screen.getByRole("button", { name: em.saveOne })).toBeDisabled();
  });
  it("retries a mutation once after refreshing CSRF", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(
      await screen.findByRole("button", { name: `${em.oneEdit} · 2026-09-01` }),
    );
    vi.mocked(editorApi.one)
      .mockRejectedValueOnce(new ApiError(403, "CSRF_INVALID"))
      .mockResolvedValueOnce({ ...draft(), revision: 3 });
    vi.mocked(api.session).mockResolvedValue({
      user: { id: "test" } as never,
      csrf_token: "fresh",
    });
    await user.click(screen.getByRole("button", { name: em.saveOne }));
    await screen.findByText(em.saved);
    expect(editorApi.one).toHaveBeenCalledTimes(2);
    expect(editorApi.one).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      "fresh",
    );
  });
  it("does not create a lesson when no confirmed assignment exists", async () => {
    const loaded = data();
    loaded.assignments = [];
    vi.mocked(editorApi.data).mockResolvedValue(loaded);
    const user = userEvent.setup();
    setup();
    await user.click(
      await screen.findByRole("button", { name: em.createSeries }),
    );
    expect(screen.getByText(em.noAssignment)).toBeVisible();
    expect(screen.getByRole("button", { name: em.saveSeries })).toBeDisabled();
  });
  it("admin prepares rooms without receiving the draft editor", async () => {
    setup(false, false, true);
    await screen.findByRole("button", { name: em.saveRoom });
    expect(
      screen.queryByRole("button", { name: em.createSeries }),
    ).not.toBeInTheDocument();
    expect(editorApi.get).not.toHaveBeenCalled();
  });
  it("shows both conflicting lessons and the exact intersection date", async () => {
    const loaded = draft();
    loaded.report.conflicts = [
      {
        rule: "RULE-001",
        resource_type: "teacher",
        resource_id: "teacher",
        resource_name: "SYNTHETIC Teacher",
        event_ids: ["a", "b"],
        dates: ["2026-09-01"],
        intersections: [{ date: "2026-09-01", start: "09:00", end: "10:30" }],
        events: [
          { ...loaded.occurrences[0], id: "a", subject: "TEST first" },
          { ...loaded.occurrences[0], id: "b", subject: "TEST second" },
        ],
      },
    ];
    vi.mocked(editorApi.get).mockResolvedValue(loaded);
    setup(false);
    expect(await screen.findByText(/TEST first/)).toBeVisible();
    expect(screen.getByText(/TEST second/)).toBeVisible();
    expect(
      screen.getByText(`${em.intersection}: 2026-09-01 09:00–10:30`),
    ).toBeVisible();
    expect(screen.queryByText(em.noConflicts)).not.toBeInTheDocument();
  });
});
