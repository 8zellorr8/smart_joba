import { request } from "./api";

export interface PendingSubmission {
  id: string;
  course_id: string;
  task_id: string;
  title: string;
  student_name: string;
  submitted_at: string;
  attempt: number;
  subject: string;
  group: string;
  data_kind: string;
  timezone: string;
}

export interface PendingAttendance {
  id: string;
  journal_id: string;
  date: string;
  start: string;
  subject: string;
  group: string;
  data_kind: string;
  missing: number;
}

export interface QueuePage<T, Cursor> {
  items: T[];
  next: Cursor | null;
}

export type SubmissionCursor = { at: string; id: string };
export type AttendanceCursor = { on: string; id: string };

const base = (scope: string) =>
  `/api/scopes/${encodeURIComponent(scope)}/teacher/queue`;

export const teacherQueueApi = {
  submissions: (scope: string, after?: SubmissionCursor) =>
    request<QueuePage<PendingSubmission, SubmissionCursor>>(
      `${base(scope)}/submissions${after ? `?after_at=${encodeURIComponent(after.at)}&after_id=${encodeURIComponent(after.id)}` : ""}`,
    ),
  attendance: (scope: string, after?: AttendanceCursor) =>
    request<QueuePage<PendingAttendance, AttendanceCursor>>(
      `${base(scope)}/attendance${after ? `?after_date=${encodeURIComponent(after.on)}&after_id=${encodeURIComponent(after.id)}` : ""}`,
    ),
};
