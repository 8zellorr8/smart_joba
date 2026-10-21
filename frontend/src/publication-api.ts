import { request } from "./api";
import type { IndependentReport, Diagnostic } from "./planning-api";

export type VersionStatus =
  "draft" | "submitted" | "rejected" | "approved" | "published" | "archived";
export interface VersionSummary {
  id: string;
  name: string;
  context_id: string;
  scope_id: string;
  academic_year: string;
  data_kind: string;
  version_number: number;
  revision: number;
  workflow_revision: number;
  status: VersionStatus;
  parent_id: string | null;
  created_at: string;
}
export interface PublicationSelection {
  group_ids: string[];
  room_ids: string[];
  semester: number;
}
export interface VersionDetail extends VersionSummary {
  event_count: number;
  selection: PublicationSelection;
  submission: {
    id: string;
    revision: number;
    stale: boolean;
    report: IndependentReport;
  } | null;
  decision: {
    id: string;
    revision: number;
    action: "approve" | "reject";
    comment: string;
    actor: string;
    created_at: string;
  } | null;
  history: {
    action: string;
    from_status: string;
    to_status: VersionStatus;
    revision: number;
    workflow_revision: number;
    comment: string;
    actor: string;
    created_at: string;
  }[];
}
export interface PublicationReadiness {
  ready: boolean;
  token: string;
  version_id: string;
  revision: number;
  workflow_revision: number;
  approval_id: string;
  report: IndependentReport;
  issues: Diagnostic[];
  issues_truncated: boolean;
}
export interface PublishCommand {
  expected_revision: number;
  expected_workflow_revision: number;
  approval_id: string;
  idempotency_key: string;
  readiness_token: string;
}
export interface PublicationReceipt {
  publication_id: string;
  version_id: string;
  version_number: number;
  revision: number;
  published_at: string;
}
export interface PublishedSummary extends PublicationReceipt {
  name: string;
  context_id: string;
  academic_year: string;
  data_kind: string;
  semester: number;
  scope_name: string;
  timezone: string;
  is_current: boolean;
  groups: string[];
  event_count: number;
  external_verified: boolean;
}
export interface ReaderEvent {
  id: string;
  date: string;
  start: string;
  end: string;
  subject: string;
  group: string;
  teacher: string;
  room: string;
}
export interface PublishedView extends PublishedSummary {
  events: ReaderEvent[];
  total: number;
  offset: number;
  limit: number;
  resources: Record<
    "group" | "teacher" | "room",
    { id: string; name: string }[]
  >;
}
export interface PublicationFilter {
  start: string;
  end: string;
  view: "group" | "teacher" | "room";
  resource_id: string;
  offset: number;
}
export const expectedVersion = (version: VersionSummary) => ({
  expected_revision: version.revision,
  expected_workflow_revision: version.workflow_revision,
});
const post = <T>(url: string, body: unknown, token: string) =>
  request<T>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
    body: JSON.stringify(body),
  });
export const versionApi = {
  list: (scope: string) =>
    request<VersionSummary[]>(
      `/api/scopes/${encodeURIComponent(scope)}/schedule-versions`,
    ),
  get: (id: string) =>
    request<VersionDetail>(`/api/schedule-versions/${encodeURIComponent(id)}`),
  submit: (
    version: VersionDetail,
    selection: PublicationSelection,
    token: string,
  ) =>
    post<VersionDetail>(
      `/api/schedule-versions/${encodeURIComponent(version.id)}/submit`,
      { ...expectedVersion(version), ...selection },
      token,
    ),
  decide: (
    version: VersionDetail,
    action: "approve" | "reject",
    comment: string,
    token: string,
  ) =>
    post<VersionDetail>(
      `/api/schedule-versions/${encodeURIComponent(version.id)}/${action}`,
      {
        ...expectedVersion(version),
        submission_id: version.submission?.id,
        comment,
      },
      token,
    ),
  reopen: (version: VersionDetail, token: string) =>
    post<VersionDetail>(
      `/api/schedule-versions/${encodeURIComponent(version.id)}/reopen`,
      expectedVersion(version),
      token,
    ),
  fork: (version: VersionDetail, name: string, token: string) =>
    post<VersionDetail>(
      `/api/schedule-versions/${encodeURIComponent(version.id)}/fork`,
      { ...expectedVersion(version), name },
      token,
    ),
  readiness: (version: VersionDetail) =>
    request<PublicationReadiness>(
      `/api/readiness?${new URLSearchParams({
        schedule_version_id: version.id,
        expected_revision: String(version.revision),
      })}`,
    ),
  publish: (id: string, body: PublishCommand, token: string) =>
    post<PublicationReceipt>(
      `/api/schedule-versions/${encodeURIComponent(id)}/publish`,
      body,
      token,
    ),
};
export const publicationApi = {
  list: (scope: string) =>
    request<PublishedSummary[]>(
      `/api/scopes/${encodeURIComponent(scope)}/publications`,
    ),
  get: (id: string, filter: PublicationFilter) =>
    request<PublishedView>(
      `/api/publications/${encodeURIComponent(id)}?${new URLSearchParams({
        ...(filter.start ? { start: filter.start } : {}),
        ...(filter.end ? { end: filter.end } : {}),
        view: filter.view,
        ...(filter.resource_id ? { resource_id: filter.resource_id } : {}),
        offset: String(filter.offset),
      })}`,
    ),
};
