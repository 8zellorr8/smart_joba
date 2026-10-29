import { request } from "./api";

export interface Student {
  id: string;
  display_name: string;
  data_kind: string;
}
export interface Membership {
  id: string;
  student_id: string;
  context_id: string;
  group_id: string;
  start: string;
  end: string;
  source: string;
  group: string;
  academic_year: string;
}
export interface Binding {
  id: string;
  user_id: string;
  student_id: string | null;
  source: string;
}
export interface Journal {
  id: string;
  group: string;
  subject: string;
  semester: number;
  academic_year: string;
  data_kind: string;
  periods?: { start: string; end: string }[];
}
export interface Assignment {
  id: string;
  journal_id: string;
  teacher_id: string;
  start: string;
  end: string;
  source: string;
  active: boolean;
}
export interface SetupData {
  revision: number;
  students: Student[];
  memberships: Membership[];
  bindings: Binding[];
  contexts: { id: string; academic_year: string; data_kind: string }[];
  groups: { id: string; code: string; data_kind: string }[];
  teachers: { id: string; display_name: string; data_kind: string }[];
  accounts: {
    id: string;
    display_name: string;
    email: string;
    group_id: string;
  }[];
  demands: {
    id: string;
    context_id: string;
    group_id: string;
    subject: string;
    semester: number;
  }[];
  journals: Journal[];
  assignments: Assignment[];
}
export interface SetupCommand {
  operation_id: string;
  expected_revision: number;
  command: Record<string, unknown>;
}
export interface SetupReceipt {
  id: string;
  revision: number;
  kind: string;
}
export interface Roster {
  journal_id: string;
  date: string;
  revision: number;
  is_snapshot: false;
  students: { id: string; display_name: string }[];
}
export interface StudyProfile {
  student: Student;
  memberships: {
    id: string;
    group: string;
    academic_year: string;
    start: string;
    end: string;
  }[];
}

const path = (scope: string) =>
  `/api/scopes/${encodeURIComponent(scope)}/journal`;
export const journalApi = {
  setup: (scope: string) => request<SetupData>(`${path(scope)}/setup`),
  command: (scope: string, csrf: string, body: SetupCommand) =>
    request<SetupReceipt>(`${path(scope)}/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify(body),
    }),
  journals: (scope: string) =>
    request<{ revision: number; journals: Journal[] }>(
      `${path(scope)}/journals`,
    ),
  roster: (scope: string, id: string, date: string) =>
    request<Roster>(
      `${path(scope)}/journals/${encodeURIComponent(id)}/roster?on=${encodeURIComponent(date)}`,
    ),
  me: (scope: string) => request<StudyProfile>(`${path(scope)}/me`),
};
