import { request } from "./api";
import type { EditorRoom } from "./editor-api";

export interface Availability {
  resource_type: "teacher" | "room";
  resource_id: string;
  start_date: string;
  end_date: string;
  weekdays: number[];
  start: string;
  end: string;
}
export interface BusyInterval {
  resource_type: "teacher" | "room" | "group";
  resource_id: string;
  date: string;
  start: string;
  end: string;
  source: string;
}
export interface RulesDocument {
  confirmed: boolean;
  source: string;
  external_confirmed: boolean;
  external_source: string;
  groups: { group_id: string; size: number | null }[];
  rooms: { room_id: string; capacity: number | null; features: string[] }[];
  needs: { demand_id: string; features: string[] }[];
  availability: Availability[];
  busy: BusyInterval[];
}
export interface PlanningData {
  contexts: {
    id: string;
    academic_year: string;
    data_kind: string;
    revision: number;
    rules_revision: number;
    rules: RulesDocument | null;
  }[];
  groups: { id: string; code: string; data_kind: string }[];
  teachers: { id: string; name: string; data_kind: string }[];
  rooms: EditorRoom[];
  demands: {
    id: string;
    context_id: string;
    group_id: string | null;
    subject: string;
    semester: number | null;
  }[];
  drafts: { id: string; context_id: string; name: string; revision: number }[];
}
export interface Selection {
  context_id: string;
  group_ids: string[];
  room_ids: string[];
  semester: number;
  base_draft_id: string | null;
}
export interface Diagnostic {
  code: string;
  subject?: string;
  group?: string;
  resource_name?: string;
  event_id?: string;
  date?: string;
  demand_id?: string;
  resource_type?: string;
  resource_id?: string;
  source?: string | { coordinate?: string; row_id?: string };
}
export interface Preview {
  token: string;
  ready: boolean;
  questions: Diagnostic[];
  question_count: number;
  demands: number;
  pins: number;
  external_verified: boolean;
}
export interface IndependentReport {
  identity: {
    draft_id?: string;
    revision?: number;
    job_id?: string;
    snapshot_id: string;
  };
  valid: boolean;
  complete: boolean;
  errors: Diagnostic[];
  questions: Diagnostic[];
  errors_truncated: boolean;
  questions_truncated: boolean;
  conflicts_truncated: boolean;
  conflicts: {
    resource_type: string;
    resource_id: string;
    resource_name?: string;
    events?: {
      id: string;
      date: string;
      start: string;
      end: string;
      subject: string;
      group: string;
    }[];
    event_ids: string[];
    dates: string[];
  }[];
  notes: string[];
  event_count: number;
  elapsed_seconds: number;
  check_scope: { context_id: string; group_ids: string[]; semester: number };
  hours: {
    demand_id: string;
    subject: string;
    group: string;
    required: string | null;
    planned: string;
    remaining: string | null;
  }[];
}
export interface SavedReport {
  id: string;
  stale: boolean;
  report: IndependentReport;
}
export interface SolverJob {
  id: string;
  context_id: string;
  status: string;
  execution_status: string;
  academic_year?: string;
  data_kind?: string;
  validation_stale?: boolean;
  stage: string;
  stale: boolean;
  elapsed_seconds: number;
  created_at: string;
  algorithm_version: string;
  parameters: {
    seconds: number;
    workers: number;
    memory_mib: number;
    process_wall_seconds: number;
  };
  snapshot_id: string;
  group_ids: string[];
  semester: number;
  result_draft_id: string | null;
  cancel_requested: boolean;
  result: {
    raw_status?: string;
    diagnostics?: Diagnostic[];
    validation?: IndependentReport;
    peak_rss_bytes?: number;
    solver_seconds?: number;
  } | null;
}
const post = <T>(url: string, body: unknown, token: string) =>
  request<T>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
    body: JSON.stringify(body),
  });
export const planningApi = {
  data: (scope: string) =>
    request<PlanningData>(
      `/api/scopes/${encodeURIComponent(scope)}/planning-data`,
    ),
  rules: (
    context: string,
    revision: number,
    document: RulesDocument,
    token: string,
  ) =>
    post<{ revision: number; document: RulesDocument }>(
      `/api/planning-contexts/${encodeURIComponent(context)}/rules`,
      { expected_revision: revision, document },
      token,
    ),
  preview: (scope: string, selection: Selection, token: string) =>
    post<Preview>(
      `/api/scopes/${encodeURIComponent(scope)}/generation-preview`,
      selection,
      token,
    ),
  create: (
    scope: string,
    selection: Selection,
    previewToken: string,
    seconds: number,
    token: string,
  ) =>
    post<SolverJob>(
      `/api/scopes/${encodeURIComponent(scope)}/solver-jobs`,
      { ...selection, token: previewToken, seconds },
      token,
    ),
  jobs: (scope: string) =>
    request<SolverJob[]>(
      `/api/scopes/${encodeURIComponent(scope)}/solver-jobs`,
    ),
  job: (id: string) =>
    request<SolverJob>(`/api/solver-jobs/${encodeURIComponent(id)}`),
  cancel: (id: string, token: string) =>
    post<SolverJob>(
      `/api/solver-jobs/${encodeURIComponent(id)}/cancel`,
      {},
      token,
    ),
  validate: (
    draft: string,
    revision: number,
    selection: Selection,
    token: string,
  ) =>
    post<SavedReport>(
      `/api/drafts/${encodeURIComponent(draft)}/validate`,
      {
        expected_revision: revision,
        group_ids: selection.group_ids,
        room_ids: selection.room_ids,
        semester: selection.semester,
      },
      token,
    ),
  reports: (draft: string) =>
    request<SavedReport[]>(
      `/api/drafts/${encodeURIComponent(draft)}/validations`,
    ),
};
