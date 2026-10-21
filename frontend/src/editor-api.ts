import { request } from "./api";
import type { CalendarDocument, PlanPattern } from "./calendar-api";

export interface EditorRoom {
  id: string;
  code: string;
  data_kind: string;
  exclusive: boolean | null;
  confirmed: boolean;
  source: string;
  revision: number;
}
export interface EditorAssignment {
  id: string;
  revision: number;
  demand_id: string;
  context_id: string;
  group_id: string;
  group: string;
  teacher_id: string;
  teacher: string;
  subject: string;
  semester: number;
}
export interface EditorCalendar {
  id: string;
  context_id: string;
  group_id: string;
  revision: number;
  document: CalendarDocument;
}
export interface EditorData {
  rooms: EditorRoom[];
  contexts: {
    id: string;
    academic_year: string;
    data_kind: string;
    revision: number;
  }[];
  assignments: EditorAssignment[];
  calendars: EditorCalendar[];
  drafts: {
    id: string;
    context_id: string;
    name: string;
    status: string;
    revision: number;
  }[];
}
export interface EditorDependencies {
  context_revision: number;
  calendars: Record<string, number | null>;
  rooms: Record<string, number | null>;
}
export interface SeriesValues {
  assignment_id: string;
  assignment_revision: number;
  calendar_id: string;
  calendar_revision: number;
  room_id: string;
  room_revision: number;
  pattern: PlanPattern;
}
export interface DraftSeries {
  id: string;
  count: number;
  template: SeriesValues;
}
export interface DraftOccurrence {
  id: string;
  series_id: string;
  base_date: string;
  date: string;
  start: string;
  end: string;
  assignment_id: string;
  assignment_revision: number;
  demand_id: string;
  group_id: string;
  group: string;
  teacher_id: string;
  teacher: string;
  subject: string;
  semester: number;
  calendar_id: string;
  calendar_revision: number;
  room_id: string;
  room: string;
  room_revision: number;
  room_exclusive: boolean | null;
  cancelled: boolean;
  pinned: boolean;
  source_coordinate: string;
}
export interface DraftConflict {
  rule: string;
  resource_type: "teacher" | "group" | "room";
  resource_id: string;
  resource_name: string;
  event_ids: string[];
  dates: string[];
  intersections: { date: string; start: string; end: string }[];
  events: Pick<
    DraftOccurrence,
    | "id"
    | "series_id"
    | "subject"
    | "group"
    | "teacher"
    | "room"
    | "date"
    | "start"
    | "end"
  >[];
}
export interface DraftReport {
  revision: number;
  stale: boolean;
  has_errors: boolean;
  conflicts: DraftConflict[];
  conflicts_truncated: boolean;
  errors: {
    code: string;
    event_id?: string;
    date?: string;
    demand_id?: string;
  }[];
  errors_truncated: boolean;
  questions: {
    code: string;
    event_id?: string;
    date?: string;
    count?: number;
  }[];
  questions_truncated: boolean;
  notes: string[];
  actual_registered: false;
  hours: {
    demand_id: string;
    subject: string;
    group: string;
    semester: number;
    source_amount: string | null;
    source_unit: string;
    planned: string;
    required: string | null;
    remaining: string | null;
  }[];
}
export interface ScheduleDraft {
  id: string;
  context_id: string;
  name: string;
  status: string;
  version_number?: number;
  workflow_revision?: number;
  academic_year: string;
  data_kind: string;
  revision: number;
  dependencies: EditorDependencies;
  stale: boolean;
  report: DraftReport;
  series: DraftSeries[];
  occurrences: DraftOccurrence[];
  total: number;
  offset: number;
  limit: number;
}
export interface DraftView {
  start: string;
  end: string;
  view: "group" | "teacher" | "room";
  resource_id: string;
  offset: number;
}
const post = <T>(path: string, body: unknown, token: string) =>
  request<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
    body: JSON.stringify(body),
  });
const expected = (draft: ScheduleDraft) => ({
  expected_revision: draft.revision,
  expected_dependencies: draft.dependencies,
});
export const editorApi = {
  data: (scope: string) =>
    request<EditorData>(`/api/scopes/${encodeURIComponent(scope)}/editor-data`),
  create: (scope: string, context: string, name: string, token: string) =>
    post<ScheduleDraft>(
      `/api/scopes/${encodeURIComponent(scope)}/drafts`,
      { context_id: context, name },
      token,
    ),
  get: (id: string, view?: DraftView) => {
    const params = new URLSearchParams();
    if (view) {
      if (view.start) params.set("start", view.start);
      if (view.end) params.set("end", view.end);
      params.set("view", view.view);
      if (view.resource_id) params.set("resource_id", view.resource_id);
      params.set("offset", String(view.offset));
    }
    return request<ScheduleDraft>(
      `/api/drafts/${encodeURIComponent(id)}?${params}`,
    );
  },
  series: (
    draft: ScheduleDraft,
    values: SeriesValues,
    token: string,
    id?: string,
  ) =>
    post<ScheduleDraft>(
      `/api/drafts/${encodeURIComponent(draft.id)}/series${id ? `/${encodeURIComponent(id)}` : ""}`,
      { ...expected(draft), ...values },
      token,
    ),
  one: (
    draft: ScheduleDraft,
    event: DraftOccurrence,
    changes: {
      date: string;
      start: string;
      end: string;
      room_id: string;
      room_revision: number;
      cancelled: boolean;
      pinned: boolean;
    },
    token: string,
  ) =>
    post<ScheduleDraft>(
      `/api/drafts/${encodeURIComponent(draft.id)}/occurrences/${encodeURIComponent(event.id)}`,
      { ...expected(draft), ...changes },
      token,
    ),
  room: (
    scope: string,
    values: Omit<EditorRoom, "id" | "revision">,
    token: string,
    room?: EditorRoom,
  ) =>
    post<EditorRoom>(
      room
        ? `/api/rooms/${encodeURIComponent(room.id)}`
        : `/api/scopes/${encodeURIComponent(scope)}/rooms`,
      { ...values, ...(room ? { expected_revision: room.revision } : {}) },
      token,
    ),
};
