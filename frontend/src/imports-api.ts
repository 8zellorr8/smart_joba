import { request } from "./api";

export const fields = [
  "teacher",
  "subject",
  "index",
  "group",
  "course",
  "room",
  "weekly_hours",
  "subgroup",
  "specialty",
  "qualification",
  "semester_hours",
  "semester",
] as const;
export type ImportField = (typeof fields)[number];
export interface ImportIssue {
  id: string;
  code: string;
  field: ImportField;
  blocking: boolean;
  coordinate: string;
}
export interface ImportRow {
  id: string;
  source_row: number;
  raw: Record<
    ImportField,
    {
      value: string | number | null;
      formula: string | null;
      cached: string | number | null;
    }
  >;
  normalized: Record<ImportField, string | number | null> & {
    whole_group: boolean;
  };
  corrections: Partial<Record<ImportField, string>> & { whole_group?: boolean };
  references_confirmed: boolean;
  issues: ImportIssue[];
  action: "new" | "changed" | "unchanged";
  previous: ImportRow["normalized"] | null;
  demand_id: string | null;
}
export interface ImportBatch {
  id: string;
  filename: string;
  sha256: string;
  sheet: string;
  range: string;
  template: string;
  hour_unit: string;
  status: "preview" | "applied";
  revision: number;
  base_revision: number;
  context_revision: number;
  stale: boolean;
  academic_year: string;
  data_kind: "college" | "synthetic";
  offset: number;
  limit: number;
  rows: ImportRow[];
  summary: {
    rows: number;
    new: number;
    changed: number;
    unchanged: number;
    missing: number;
    open_issues: number;
    ready: number;
    duplicate_rows: number;
  };
  missing: { id: string; group: string; subject: string }[];
}
export interface BatchListItem {
  id: string;
  filename: string;
  academic_year: string;
  data_kind: string;
  status: string;
}
export interface HistoryItem {
  id: string;
  revision: number;
  previous_revision_id: string | null;
  normalized: ImportRow["normalized"];
  source: { filename: string; sheet: string; row: number };
}

export const importsApi = {
  list: (scope: string) =>
    request<BatchListItem[]>(
      `/api/scopes/${encodeURIComponent(scope)}/imports`,
    ),
  preview: (scope: string, form: FormData, csrf: string) =>
    request<ImportBatch>(
      `/api/scopes/${encodeURIComponent(scope)}/imports/s1`,
      { method: "POST", headers: { "X-CSRF-Token": csrf }, body: form },
    ),
  get: (id: string, offset = 0) =>
    request<ImportBatch>(
      `/api/imports/${encodeURIComponent(id)}?offset=${offset}`,
    ),
  review: (
    batch: string,
    row: string,
    revision: number,
    corrections: object,
    references: boolean,
    csrf: string,
  ) =>
    request<ImportBatch>(
      `/api/imports/${encodeURIComponent(batch)}/rows/${encodeURIComponent(row)}/review`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify({
          expected_revision: revision,
          corrections,
          references_confirmed: references,
        }),
      },
    ),
  apply: (batch: string, revision: number, csrf: string) =>
    request<ImportBatch>(`/api/imports/${encodeURIComponent(batch)}/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ expected_revision: revision, confirmed: true }),
    }),
  history: (batch: string, row: string) =>
    request<HistoryItem[]>(
      `/api/imports/${encodeURIComponent(batch)}/rows/${encodeURIComponent(row)}/history`,
    ),
};
