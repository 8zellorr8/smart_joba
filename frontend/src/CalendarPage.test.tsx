import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "./api";
import { calendarApi } from "./calendar-api";
import type { CalendarProfile, PlanPreview } from "./calendar-api";
import { CalendarPage, emptyCalendar } from "./CalendarPage";
import { cm } from "./locales/calendar.kk";

vi.mock("./calendar-api", () => ({
  calendarApi: {
    data: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    dates: vi.fn(),
    preview: vi.fn(),
    history: vi.fn(),
  },
}));
vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  api: { session: vi.fn() },
}));
function sample(): CalendarProfile {
  return {
    id: "calendar",
    context_id: "context",
    group_id: "group",
    group_code: "TEST-A",
    academic_year: "2026-2027",
    data_kind: "synthetic",
    revision: 1,
    context_revision: 2,
    document: {
      ...emptyCalendar(),
      start: "2026-09-01",
      end: "2026-11-16",
      slots: [
        { id: "first", label: "TEST 90 min", start: "09:00", end: "10:30" },
      ],
      periods: [
        {
          start: "2026-09-01",
          end: "2026-11-16",
          kind: "theory",
          label: "TEST",
        },
      ],
    },
  };
}
function result(hours = "20"): PlanPreview {
  return {
    occurrences: [],
    valid: true,
    calendar_ready: false,
    assumptions: ["confirmed"],
    active_count: 10,
    cancelled_count: 0,
    blocked_count: 0,
    planned_minutes: Number(hours) * 45,
    planned_academic_hours: hours,
    planned_academic_exact: `${hours}/1`,
    planned_pairs: "10",
    required_academic_hours: null,
    remaining_academic_hours: null,
    demand: null,
    actual_registered: false,
    preview_only: true,
    dependency_token: {
      calendar_id: "calendar",
      calendar_revision: 1,
      context_id: "context",
      context_revision: 2,
    },
  };
}
function setup(canWrite = true) {
  return render(
    <CalendarPage
      scope="scope"
      csrfToken="csrf"
      canWrite={canWrite}
      onExpired={vi.fn()}
    />,
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  const profile = sample();
  vi.mocked(calendarApi.data).mockResolvedValue({
    groups: [{ id: "group", code: "TEST-A", data_kind: "synthetic" }],
    profiles: [profile],
    demands: [],
  });
  vi.mocked(calendarApi.preview).mockResolvedValue(result());
});
describe("calendar and hours", () => {
  it("requires confirmation again after changing a confirmed minute norm", async () => {
    const user = userEvent.setup();
    const profile = sample();
    profile.document.units_confirmed = true;
    profile.document.units_source = "SYNTHETIC TEST norm";
    vi.mocked(calendarApi.data).mockResolvedValue({
      groups: [],
      profiles: [profile],
      demands: [],
    });
    setup();
    const minutes = await screen.findByLabelText(cm.academic);
    expect(screen.getByLabelText(cm.unitsConfirmed)).toBeChecked();
    await user.clear(minutes);
    await user.type(minutes, "60");
    expect(screen.getByLabelText(cm.unitsConfirmed)).not.toBeChecked();
  });
  it("read-only scheduler can calculate but cannot edit or save settings", async () => {
    setup(false);
    await screen.findByRole("button", { name: cm.calculate });
    expect(screen.getByLabelText(cm.academic)).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: cm.save }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: cm.calculate })).toBeEnabled();
  });
  it("keeps edited settings after stale rejection and blocks calculation", async () => {
    const user = userEvent.setup();
    setup();
    const input = await screen.findByLabelText(cm.academic);
    await user.clear(input);
    await user.type(input, "60");
    vi.mocked(calendarApi.update).mockRejectedValue(
      new ApiError(409, "CALENDAR_STALE"),
    );
    await user.click(screen.getByRole("button", { name: cm.save }));
    expect(await screen.findByRole("alert")).toHaveTextContent(cm.stale);
    expect(input).toHaveValue(60);
    expect(screen.getByRole("button", { name: cm.calculate })).toBeDisabled();
    expect(screen.queryByText(cm.saved)).not.toBeInTheDocument();
  });
  it("removes old hour result when cancellation changes and submits the exact date", async () => {
    const user = userEvent.setup();
    setup(false);
    await user.click(await screen.findByRole("button", { name: cm.calculate }));
    expect(await screen.findByText("20")).toBeVisible();
    await user.type(screen.getByLabelText(cm.cancelled), "2026-09-08");
    expect(screen.queryByText("20")).not.toBeInTheDocument();
    vi.mocked(calendarApi.preview).mockResolvedValue(result("18"));
    await user.click(screen.getByRole("button", { name: cm.calculate }));
    expect(await screen.findByText("18")).toBeVisible();
    expect(calendarApi.preview).toHaveBeenLastCalledWith(
      expect.objectContaining({ revision: 1 }),
      [expect.objectContaining({ cancelled_dates: ["2026-09-08"] })],
      "",
      "csrf",
    );
  });
  it("unsaved minute change invalidates old preview", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(await screen.findByRole("button", { name: cm.calculate }));
    await screen.findByText("20");
    await user.clear(screen.getByLabelText(cm.academic));
    expect(screen.queryByText("20")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: cm.calculate })).toBeDisabled();
  });
  it("failed save preserves source and never claims success", async () => {
    const user = userEvent.setup();
    setup();
    const source = await screen.findByLabelText(cm.source);
    await user.type(source, "TEST changed source");
    vi.mocked(calendarApi.update).mockRejectedValue(
      new ApiError(503, "SERVICE_UNAVAILABLE"),
    );
    await user.click(screen.getByRole("button", { name: cm.save }));
    expect(await screen.findByRole("alert")).toHaveTextContent(cm.error);
    expect(source).toHaveValue("TEST changed source");
    expect(screen.queryByText(cm.saved)).not.toBeInTheDocument();
  });
  it("refreshes CSRF once and retries the same calculation", async () => {
    const user = userEvent.setup();
    setup(false);
    vi.mocked(calendarApi.preview)
      .mockRejectedValueOnce(new ApiError(403, "CSRF_INVALID"))
      .mockResolvedValueOnce(result());
    vi.mocked(api.session).mockResolvedValue({
      user: { id: "test" } as never,
      csrf_token: "fresh",
    });
    await user.click(await screen.findByRole("button", { name: cm.calculate }));
    await screen.findByText("20");
    expect(calendarApi.preview).toHaveBeenCalledTimes(2);
    expect(calendarApi.preview).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      "",
      "fresh",
    );
  });
  it("sends explicit Tuesday through Monday dates without shifting them", async () => {
    const user = userEvent.setup();
    setup(false);
    await screen.findByRole("button", { name: cm.showDates });
    await user.clear(
      screen.getByLabelText(cm.start, { selector: "#dates-start" }),
    );
    await user.type(
      screen.getByLabelText(cm.start, { selector: "#dates-start" }),
      "2026-10-27",
    );
    await user.clear(screen.getByLabelText(cm.end, { selector: "#dates-end" }));
    await user.type(
      screen.getByLabelText(cm.end, { selector: "#dates-end" }),
      "2026-11-02",
    );
    vi.mocked(calendarApi.dates).mockResolvedValue({
      dates: [],
      revision: 1,
      context_revision: 2,
    });
    await user.click(screen.getByRole("button", { name: cm.showDates }));
    await waitFor(() =>
      expect(calendarApi.dates).toHaveBeenCalledWith(
        "calendar",
        "2026-10-27",
        "2026-11-02",
      ),
    );
  });
});
