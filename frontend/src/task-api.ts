import { request, requestBlob } from "./api";

export interface Task {
  id: string;
  title: string;
  instructions: string;
  due_on: string | null;
  timezone: string;
  revision?: number;
}
export interface TaskReview {
  revision: number;
  outcome: "graded" | "returned";
  grade: number | null;
  feedback: string;
  reason?: string;
  created_at: string;
}
export interface Submission {
  id: string;
  student_name: string;
  attempt: number;
  submitted_at: string;
  kind: "text" | "pdf";
  late: boolean;
  task_revision?: number;
  conditions?: Task;
  review: TaskReview | null;
  text?: string | null;
  reviews?: TaskReview[];
}
export interface TaskDetails {
  task: Task;
  can_manage: boolean;
  attempts: Submission[];
}
export interface SubmissionPage {
  items: Submission[];
  next: string | null;
}
export interface TaskCreate {
  id: string;
  topic_id: string;
  title: string;
  instructions: string;
  due_on: string | null;
}
export interface TaskUpdate {
  id: string;
  expected_revision: number;
  title: string;
  instructions: string;
  due_on: string | null;
}
export interface ReviewInput {
  id: string;
  expected_revision: number;
  outcome: "graded" | "returned";
  grade: number | null;
  feedback: string;
  reason: string;
}
const root = (scope: string, course: string) =>
  `/api/scopes/${encodeURIComponent(scope)}/courses/${course}/tasks`;
const post = (csrf: string, body: unknown) => ({
  method: "POST",
  headers: { "X-CSRF-Token": csrf, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
export const taskApi = {
  create: (scope: string, course: string, data: TaskCreate, csrf: string) =>
    request<{ id: string }>(root(scope, course), post(csrf, data)),
  update: (
    scope: string,
    course: string,
    task: string,
    data: TaskUpdate,
    csrf: string,
  ) =>
    request<{ id: string; revision: number }>(
      `${root(scope, course)}/${task}`,
      { ...post(csrf, data), method: "PUT" },
    ),
  get: (scope: string, course: string, task: string) =>
    request<TaskDetails>(`${root(scope, course)}/${task}`),
  submissions: (scope: string, course: string, task: string, after?: string) =>
    request<SubmissionPage>(
      `${root(scope, course)}/${task}/submissions${after ? "?after=" + encodeURIComponent(after) : ""}`,
    ),
  attempts: (scope: string, course: string, task: string, submission: string) =>
    request<{ attempts: Submission[] }>(
      `${root(scope, course)}/${task}/submissions/${submission}`,
    ),
  submit: (
    scope: string,
    course: string,
    task: string,
    body: FormData,
    csrf: string,
  ) =>
    request(`${root(scope, course)}/${task}/submissions`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrf },
      body,
    }),
  review: (
    scope: string,
    course: string,
    task: string,
    submission: string,
    body: ReviewInput,
    csrf: string,
  ) =>
    request(
      `${root(scope, course)}/${task}/submissions/${submission}/reviews`,
      post(csrf, body),
    ),
  pdf: (scope: string, course: string, task: string, submission: string) =>
    requestBlob(`${root(scope, course)}/${task}/submissions/${submission}/pdf`),
};
