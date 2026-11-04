import { request } from "./api";

export type Attendance = "present" | "absent" | "late" | "excused" | null;
export interface LessonSummary {
  lesson_id: string | null;
  publication_id: string;
  event_id: string;
  date: string;
  start: string;
  end: string;
  recorded: boolean;
  needs_mapping: boolean;
  blocked: string | null;
}
export interface LessonPage {
  items: LessonSummary[];
  total: number;
  offset: number;
  limit: number;
  registry_revision: number;
}
export interface LessonStudent {
  student_id: string;
  display_name: string;
  active: boolean;
  attendance: Attendance;
  grade: number | null;
}
export interface Lesson {
  id: string | null;
  journal_id: string;
  revision: number;
  registry_revision: number;
  recorded: boolean;
  topic: string;
  students: LessonStudent[];
  source: {
    publication_id: string;
    event_id: string;
    date: string;
    start: string;
    end: string;
    timezone: string;
    version_number: number;
    publication_revision: number;
    subject: string;
    group: string;
    teacher: string;
    room: string;
  };
  source_changed: boolean;
  current_links: { publication_id: string; event_id: string }[];
  can_write: boolean;
  blocked?: string | null;
}
export interface LessonCommand {
  operation_id: string;
  expected_revision: number;
  expected_registry_revision: number;
  command: Record<string, unknown>;
}
export interface LessonReceipt {
  lesson_id: string | null;
  revision: number;
  registry_revision: number;
  kind: string;
}
export interface RosterCorrection {
  lesson_id: string;
  revision: number;
  registry_revision: number;
  date: string;
  students: { student_id: string; display_name: string; active: boolean }[];
}
export interface LessonChange {
  id: string;
  action: string;
  actor_id: string;
  actor_name?: string;
  created_at: string;
  reason: string;
  revision: number;
  before: { lesson?: { topic: string }; students?: HistoricalStudent[] };
  after: { lesson?: { topic: string }; students?: HistoricalStudent[] };
}
type HistoricalStudent = Omit<LessonStudent, "grade"> & {
  grade?: number | null;
};
const path = (scope: string) =>
  `/api/scopes/${encodeURIComponent(scope)}/journal`;
export const lessonApi = {
  list: (
    scope: string,
    journal: string,
    offset = 0,
    admin = false,
    recordedOnly = false,
  ) =>
    request<LessonPage>(
      `${path(scope)}/${admin ? "lesson-admin/journals" : "journals"}/${encodeURIComponent(journal)}${admin ? "" : "/lessons"}?offset=${offset}${recordedOnly ? "&recorded_only=true" : ""}`,
    ),
  preview: (scope: string, journal: string, row: LessonSummary) =>
    request<Lesson>(
      `${path(scope)}/journals/${encodeURIComponent(journal)}/event?publication_id=${encodeURIComponent(row.publication_id)}&event_id=${encodeURIComponent(row.event_id)}`,
    ),
  get: (scope: string, id: string) =>
    request<Lesson>(`${path(scope)}/lessons/${encodeURIComponent(id)}`),
  command: (scope: string, csrf: string, body: LessonCommand, admin = false) =>
    request<LessonReceipt>(
      `${path(scope)}/${admin ? "lesson-admin/commands" : "lesson-commands"}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify(body),
      },
    ),
  history: (scope: string, id: string, offset = 0) =>
    request<{ items: LessonChange[]; next_offset: number | null }>(
      `${path(scope)}/lessons/${encodeURIComponent(id)}/history?offset=${offset}`,
    ),
  adminRoster: (scope: string, id: string) =>
    request<RosterCorrection>(
      `${path(scope)}/lesson-admin/lessons/${encodeURIComponent(id)}/roster`,
    ),
};
