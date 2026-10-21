import { request } from "./api";

export type DayKind =
  "theory" | "practice" | "vacation" | "attestation" | "nonstudy" | "unknown";
export interface CalendarDocument {
  start: string;
  end: string;
  timezone: string;
  academic_minutes: number;
  pair_minutes: number;
  confirmed: boolean;
  source: string;
  units_confirmed: boolean;
  units_source: string;
  timezone_confirmed: boolean;
  timezone_source: string;
  periods: {
    start: string;
    end: string;
    kind: DayKind;
    semester?: number | null;
    label: string;
  }[];
  slots: { id: string; label: string; start: string; end: string }[];
  exceptions: { date: string; allowed: boolean; reason: string }[];
}
export interface CalendarProfile {
  id: string;
  context_id: string;
  group_id: string;
  group_code: string;
  academic_year: string;
  data_kind: "college" | "synthetic";
  revision: number;
  context_revision: number;
  document: CalendarDocument;
}
export interface CalendarData {
  groups: { id: string; code: string; data_kind: string }[];
  profiles: CalendarProfile[];
  demands: {
    id: string;
    group_id: string | null;
    context_id: string;
    subject: string;
    semester: number | null;
    semester_amount: string | null;
    weekly_amount: string | null;
    unit: string;
    confirmed: boolean;
  }[];
}
export interface CalendarDay {
  date: string;
  weekday: number;
  kind: DayKind;
  allowed: boolean;
  period_label: string;
  exception: { allowed: boolean; reason: string } | null;
}
export interface PlanPattern {
  id: string;
  start: string;
  end: string;
  slot_id: string;
  weekdays: number[];
  dates: string[];
  cancelled_dates: string[];
}
export interface PlanPreview {
  occurrences: (CalendarDay & {
    pattern_id: string;
    start: string;
    end: string;
    status: "planned" | "cancelled" | "blocked";
    duration_minutes: number;
  })[];
  comparison_issue?: string | null;
  valid: boolean;
  calendar_ready: boolean;
  assumptions: string[];
  active_count: number;
  cancelled_count: number;
  blocked_count: number;
  planned_minutes: number;
  planned_academic_hours: string;
  planned_academic_exact: string;
  planned_pairs: string;
  required_academic_hours: string | null;
  remaining_academic_hours: string | null;
  demand: {
    semester_amount: string | null;
    weekly_amount: string | null;
    unit: string;
    confirmed: boolean;
    source_coordinate: string;
  } | null;
  actual_registered: false;
  preview_only: true;
  dependency_token: {
    calendar_id: string;
    calendar_revision: number;
    context_id: string;
    context_revision: number;
  };
}
export interface CalendarHistory {
  id: string;
  revision: number;
  document: CalendarDocument;
  created_at: string;
}
const post = <T>(path: string, body: unknown, csrf: string) =>
  request<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: JSON.stringify(body),
  });
export const calendarApi = {
  data: (scope: string) =>
    request<CalendarData>(
      `/api/scopes/${encodeURIComponent(scope)}/calendar-data`,
    ),
  get: (id: string) =>
    request<CalendarProfile>(`/api/calendars/${encodeURIComponent(id)}`),
  create: (scope: string, body: unknown, csrf: string) =>
    post<CalendarProfile>(
      `/api/scopes/${encodeURIComponent(scope)}/calendars`,
      body,
      csrf,
    ),
  update: (
    profile: CalendarProfile,
    document: CalendarDocument,
    csrf: string,
  ) =>
    post<CalendarProfile>(
      `/api/calendars/${encodeURIComponent(profile.id)}`,
      {
        expected_revision: profile.revision,
        expected_context_revision: profile.context_revision,
        document,
      },
      csrf,
    ),
  dates: (id: string, start: string, end: string) =>
    request<{
      dates: CalendarDay[];
      revision: number;
      context_revision: number;
    }>(
      `/api/calendars/${encodeURIComponent(id)}/dates?${new URLSearchParams({ start, end })}`,
    ),
  preview: (
    profile: CalendarProfile,
    patterns: PlanPattern[],
    demand: string,
    csrf: string,
  ) =>
    post<PlanPreview>(
      `/api/calendars/${encodeURIComponent(profile.id)}/preview`,
      {
        expected_revision: profile.revision,
        expected_context_revision: profile.context_revision,
        patterns,
        demand_id: demand || null,
      },
      csrf,
    ),
  history: (id: string) =>
    request<CalendarHistory[]>(
      `/api/calendars/${encodeURIComponent(id)}/history`,
    ),
};
