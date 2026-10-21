import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { api, ApiError } from "./api";
import { fields, importsApi } from "./imports-api";
import type {
  BatchListItem,
  HistoryItem,
  ImportBatch,
  ImportField,
  ImportRow,
} from "./imports-api";
import {
  fieldNames,
  im,
  importErrors,
  issueMessages,
} from "./locales/imports.kk";
import "./imports.css";
import { demoFileName, demoName } from "./demo-labels";
import { PageHeading } from "./ui/PageHeading";
import { StatusBadge } from "./ui/StatusBadge";

interface Props {
  scope: string;
  csrfToken: string;
  canWrite: boolean;
  onExpired: () => void;
}
const rowValues = (row: ImportRow) =>
  Object.fromEntries(
    fields.map((field) => [field, String(row.normalized[field] ?? "")]),
  ) as Record<ImportField, string>;

export function ImportPage({ scope, csrfToken, canWrite, onExpired }: Props) {
  const [csrf, setCsrf] = useState(csrfToken);
  const [items, setItems] = useState<BatchListItem[]>([]);
  const [batch, setBatch] = useState<ImportBatch | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [year, setYear] = useState("2026-2027");
  const [kind, setKind] = useState("college");
  const [sheet, setSheet] = useState("Жүктеме");
  const [lastRow, setLastRow] = useState("237");
  const [unit, setUnit] = useState("source_hour");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [selected, setSelected] = useState<ImportRow | null>(null);
  const [values, setValues] = useState<Record<ImportField, string> | null>(
    null,
  );
  const [wholeGroup, setWholeGroup] = useState(false);
  const [references, setReferences] = useState(false);
  const [formulaConfirmations, setFormulaConfirmations] = useState<
    ImportField[]
  >([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setCsrf(csrfToken);
  }, [csrfToken]);
  useEffect(() => {
    let active = true;
    void importsApi
      .list(scope)
      .then(async (loaded) => {
        if (!active) return;
        setItems(loaded);
        if (loaded.length) {
          const first = await importsApi.get(loaded[0].id);
          if (active) setBatch(first);
        }
      })
      .catch((problem) => {
        if (active) setError(message(problem));
      });
    return () => {
      active = false;
    };
  }, [scope]);

  function message(problem: unknown) {
    if (problem instanceof ApiError)
      return importErrors[problem.code] ?? im.error;
    return im.error;
  }
  async function act(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (problem) {
      if (problem instanceof ApiError && problem.status === 401) onExpired();
      else setError(message(problem));
    } finally {
      setBusy(false);
    }
  }
  async function mutate<T>(action: (token: string) => Promise<T>): Promise<T> {
    try {
      return await action(csrf);
    } catch (problem) {
      if (!(problem instanceof ApiError) || problem.code !== "CSRF_INVALID")
        throw problem;
      const refreshed = await api.session();
      if (!refreshed.user) throw new ApiError(401, "AUTH_REQUIRED");
      setCsrf(refreshed.csrf_token);
      return action(refreshed.csrf_token);
    }
  }
  async function openRow(row: ImportRow) {
    setSelected(row);
    setValues(rowValues(row));
    setWholeGroup(row.normalized.whole_group);
    setReferences(row.references_confirmed);
    setFormulaConfirmations([]);
    setDirty(false);
    setHistory(await importsApi.history(batch!.id, row.id));
  }
  function resetRow() {
    setSelected(null);
    setValues(null);
    setDirty(false);
    setHistory([]);
  }
  async function load(id: string, offset = 0) {
    const loaded = await importsApi.get(id, offset);
    setBatch(loaded);
    setConfirmed(false);
    resetRow();
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!file) {
      setError(im.noFile);
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError(importErrors.IMPORT_FILE_TOO_LARGE);
      return;
    }
    void act(async () => {
      const form = new FormData();
      form.append("file", file);
      form.append("academic_year", year);
      form.append("data_kind", kind);
      form.append("sheet", sheet);
      form.append("last_row", lastRow);
      form.append("hour_unit", unit);
      form.append("template", "s1-v1");
      const loaded = await mutate((token) =>
        importsApi.preview(scope, form, token),
      );
      setBatch(loaded);
      setConfirmed(false);
      resetRow();
      setItems(await importsApi.list(scope));
    });
  }
  function save(event: FormEvent) {
    event.preventDefault();
    if (!batch || !selected || !values) return;
    const initial = rowValues(selected);
    const corrections: Record<string, string | boolean> = {};
    for (const field of fields)
      if (
        values[field] !== initial[field] ||
        formulaConfirmations.includes(field)
      )
        corrections[field] = values[field];
    if (wholeGroup !== selected.normalized.whole_group)
      corrections.whole_group = wholeGroup;
    void act(async () => {
      const updated = await mutate((token) =>
        importsApi.review(
          batch.id,
          selected.id,
          batch.revision,
          corrections,
          references,
          token,
        ),
      );
      setBatch(updated);
      setConfirmed(false);
      const row = updated.rows.find((row) => row.id === selected.id);
      if (row) await openRow(row);
      else resetRow();
      setNotice(im.saved);
    });
  }
  const editing = canWrite && batch?.status === "preview" && !batch.stale;
  const label = (status: string) =>
    status === "applied" ? im.applied : im.previewStatus;

  return (
    <section
      className="import-page"
      aria-labelledby="import-title"
      aria-busy={busy}
    >
      <PageHeading
        id="import-title"
        eyebrow={im.subtitle}
        title={im.title}
        description={im.description}
      />
      <div aria-live="polite" aria-atomic="true">
        {error && (
          <p role="alert" className="error-message import-notice">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="notice import-notice">
            {notice}
          </p>
        )}
        {busy && <p role="status">{im.loading}</p>}
      </div>
      {!canWrite && <p className="import-muted">{im.readOnly}</p>}
      {canWrite && (
        <form className="panel import-upload" onSubmit={submit}>
          <h2>1. {im.upload}</h2>
          <p className="import-muted">{im.sourceHint}</p>
          <div className="import-fields">
            <label className="import-file">
              {im.file}
              <input
                type="file"
                accept=".xlsx"
                disabled={busy || dirty}
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
            </label>
            <label>
              {im.year}
              <input
                value={year}
                onChange={(event) => setYear(event.target.value)}
                required
                pattern="20[0-9]{2}-20[0-9]{2}"
                disabled={busy || dirty}
              />
            </label>
            <label>
              {im.dataKind}
              <select
                aria-label={im.dataKind}
                value={kind}
                onChange={(event) => setKind(event.target.value)}
                disabled={busy || dirty}
              >
                <option value="college">{im.college}</option>
                <option value="synthetic">{im.synthetic}</option>
              </select>
            </label>
            <label>
              {im.sheet}
              <input
                value={sheet}
                onChange={(event) => setSheet(event.target.value)}
                maxLength={31}
                required
                disabled={busy || dirty}
              />
            </label>
            <label>
              {im.lastRow}
              <input
                type="number"
                min="2"
                max="5000"
                value={lastRow}
                onChange={(event) => setLastRow(event.target.value)}
                required
                disabled={busy || dirty}
              />
            </label>
            <label>
              {im.unit}
              <select
                aria-label={im.unit}
                value={unit}
                onChange={(event) => setUnit(event.target.value)}
                disabled={busy || dirty}
              >
                {(
                  ["source_hour", "academic_hour", "pair", "minute"] as const
                ).map((key) => (
                  <option key={key} value={key}>
                    {im[key]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="import-muted">{im.unitHint}</p>
          <button
            className="button button-primary"
            disabled={busy || !file || dirty}
          >
            {im.makePreview}
          </button>
        </form>
      )}
      <div className="import-history-picker">
        <label>
          {im.historyTitle}
          <select
            aria-label={im.historyTitle}
            value={batch?.id ?? ""}
            disabled={busy || dirty || !items.length}
            onChange={(event) => void act(() => load(event.target.value))}
          >
            <option value="" disabled>
              {im.chooseBatch}
            </option>
            {items.map((item) => (
              <option key={item.id} value={item.id} title={item.filename}>
                {demoFileName(item.filename, item.data_kind)} ·{" "}
                {item.academic_year} · {label(item.status)}
              </option>
            ))}
          </select>
        </label>
        {batch && (
          <button
            className="button button-quiet"
            disabled={busy || dirty}
            onClick={() => void act(() => load(batch.id, batch.offset))}
          >
            {im.refresh}
          </button>
        )}
      </div>
      {!batch && <p className="empty-message">{im.noBatches}</p>}
      {batch && (
        <>
          <section
            className="panel import-preview"
            aria-labelledby="preview-title"
          >
            <div className="import-preview-heading">
              <div>
                <h2 id="preview-title">2. {im.preview}</h2>
                <p className="import-filename">
                  {demoFileName(batch.filename, batch.data_kind)}
                </p>
                {demoFileName(batch.filename, batch.data_kind) !==
                  batch.filename && (
                  <p className="import-muted">
                    {im.originalFile}: {batch.filename}
                  </p>
                )}
                <p className="import-muted">
                  {batch.sheet}!{batch.range} · {batch.academic_year} ·{" "}
                  {batch.data_kind === "college" ? im.college : im.synthetic}
                </p>
              </div>
              <div>
                <StatusBadge
                  tone={batch.status === "applied" ? "success" : "warning"}
                >
                  {label(batch.status)}
                </StatusBadge>
                <a
                  href={`/api/imports/${batch.id}/source`}
                  className="import-source"
                >
                  {im.source}
                </a>
              </div>
            </div>
            {batch.stale && (
              <p role="alert" className="error-message import-notice">
                {im.stale}. {importErrors.IMPORT_STALE}
              </p>
            )}
            <dl className="import-stats">
              {(
                [
                  "rows",
                  "new",
                  "changed",
                  "unchanged",
                  "ready",
                  "questions",
                ] as const
              ).map((key) => (
                <div key={key}>
                  <dt>{im[key]}</dt>
                  <dd>
                    {batch.summary[key === "questions" ? "open_issues" : key]}
                  </dd>
                </div>
              ))}
            </dl>
            {batch.summary.open_issues > 0 && (
              <p className="import-question-note">{im.questionHint}</p>
            )}
            <div
              className="import-table-scroll"
              role="region"
              aria-label={im.preview}
              tabIndex={0}
            >
              <table className="import-table">
                <thead>
                  <tr>
                    <th scope="col">{im.location}</th>
                    <th scope="col">{fieldNames.group}</th>
                    <th scope="col">{fieldNames.subject}</th>
                    <th scope="col">{fieldNames.teacher}</th>
                    <th scope="col">{fieldNames.weekly_hours}</th>
                    <th scope="col">{fieldNames.room}</th>
                    <th scope="col">{im.status}</th>
                  </tr>
                </thead>
                <tbody>
                  {batch.rows.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <button
                          className="import-row-open"
                          aria-label={`${canWrite ? im.review : im.view} · ${row.source_row}`}
                          disabled={busy || dirty}
                          onClick={() => void act(() => openRow(row))}
                        >
                          {batch.sheet}!A{row.source_row}:L{row.source_row}
                          <small>{canWrite ? im.review : im.view}</small>
                        </button>
                      </td>
                      <td title={String(row.normalized.group ?? "")}>
                        {demoName(row.normalized.group ?? "—", batch.data_kind)}
                      </td>
                      <td>
                        {demoName(
                          row.normalized.subject ?? "—",
                          batch.data_kind,
                        )}
                        <small>
                          {demoName(
                            row.normalized.index ?? "",
                            batch.data_kind,
                          )}
                        </small>
                      </td>
                      <td title={String(row.normalized.teacher ?? "")}>
                        {demoName(
                          row.normalized.teacher ?? "—",
                          batch.data_kind,
                        )}
                      </td>
                      <td>{row.normalized.weekly_hours ?? "—"}</td>
                      <td>
                        {demoName(row.normalized.room ?? "—", batch.data_kind)}
                      </td>
                      <td>
                        <StatusBadge
                          tone={row.issues.length ? "warning" : "info"}
                        >
                          {row.issues.length
                            ? `${im.needsReview} (${row.issues.length})`
                            : im.noQuestions}
                        </StatusBadge>
                        <small>{im[row.action]}</small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="import-pagination">
              <button
                className="button button-quiet"
                disabled={busy || dirty || batch.offset === 0}
                onClick={() =>
                  void act(() =>
                    load(batch.id, Math.max(0, batch.offset - batch.limit)),
                  )
                }
              >
                {im.previous}
              </button>
              <span>
                {batch.offset + 1}–
                {Math.min(batch.offset + batch.limit, batch.summary.rows)} /{" "}
                {batch.summary.rows}
              </span>
              <button
                className="button button-quiet"
                disabled={
                  busy ||
                  dirty ||
                  batch.offset + batch.limit >= batch.summary.rows
                }
                onClick={() =>
                  void act(() => load(batch.id, batch.offset + batch.limit))
                }
              >
                {im.next}
              </button>
            </div>
            {batch.missing.length > 0 && (
              <details className="import-missing">
                <summary>
                  {im.missing}: {batch.missing.length}
                </summary>
                <p>{im.missingHint}</p>
                <ul>
                  {batch.missing.map((item) => (
                    <li key={item.id}>
                      {demoName(item.group, batch.data_kind)} ·{" "}
                      {demoName(item.subject, batch.data_kind)}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>
          {selected && values && (
            <section
              className="panel import-review"
              aria-labelledby="row-title"
            >
              <div className="import-preview-heading">
                <h2 id="row-title">
                  {im.rowTitle}: {batch.sheet}!A{selected.source_row}:L
                  {selected.source_row}
                </h2>
                <button
                  type="button"
                  className="button button-quiet"
                  disabled={busy}
                  onClick={resetRow}
                >
                  {im.close}
                </button>
              </div>
              {dirty && (
                <p role="status" className="import-muted">
                  {im.dirty}
                </p>
              )}
              {selected.issues.length > 0 && (
                <ul className="import-issues">
                  {selected.issues.map((issue) => (
                    <li key={issue.id}>
                      <strong>
                        {batch.sheet}!{issue.coordinate} ·{" "}
                        {fieldNames[issue.field]}
                      </strong>
                      <span>{issueMessages[issue.code] ?? im.needsReview}</span>
                    </li>
                  ))}
                </ul>
              )}
              <form onSubmit={save}>
                <div className="import-review-fields">
                  {fields.map((field) => (
                    <div key={field} className="import-review-field">
                      <label htmlFor={`review-${field}`}>
                        {fieldNames[field]}
                      </label>
                      <span className="import-original">
                        {im.original}:{" "}
                        {String(selected.raw[field].value ?? im.originalEmpty)}
                      </span>
                      <input
                        id={`review-${field}`}
                        value={values[field]}
                        disabled={!editing || busy}
                        onChange={(event) => {
                          setValues({ ...values, [field]: event.target.value });
                          setDirty(true);
                        }}
                      />
                      {selected.previous &&
                        String(selected.previous[field] ?? "") !==
                          String(selected.normalized[field] ?? "") && (
                          <span className="import-previous">
                            {im.previous}:{" "}
                            {String(selected.previous[field] ?? "—")}
                          </span>
                        )}
                      {selected.raw[field].formula && editing && (
                        <label className="import-check">
                          <input
                            type="checkbox"
                            checked={formulaConfirmations.includes(field)}
                            disabled={busy}
                            onChange={(event) => {
                              setFormulaConfirmations(
                                event.target.checked
                                  ? [...formulaConfirmations, field]
                                  : formulaConfirmations.filter(
                                      (value) => value !== field,
                                    ),
                              );
                              setDirty(true);
                            }}
                          />
                          {im.formulaConfirm}
                        </label>
                      )}
                    </div>
                  ))}
                </div>
                <label className="import-check">
                  <input
                    type="checkbox"
                    checked={wholeGroup}
                    disabled={!editing || busy}
                    onChange={(event) => {
                      setWholeGroup(event.target.checked);
                      setDirty(true);
                    }}
                  />
                  {im.wholeGroup}
                </label>
                <label className="import-check">
                  <input
                    type="checkbox"
                    checked={references}
                    disabled={!editing || busy}
                    onChange={(event) => {
                      setReferences(event.target.checked);
                      setDirty(true);
                    }}
                  />
                  {im.references}
                </label>
                {editing && (
                  <button
                    className="button button-primary"
                    disabled={busy || !dirty}
                  >
                    {im.save}
                  </button>
                )}
              </form>
              <details className="import-revisions">
                <summary>{im.revisions}</summary>
                {history.length ? (
                  <ol>
                    {history.map((item) => (
                      <li key={item.id}>
                        <strong>
                          {im.revision} {item.revision}
                        </strong>{" "}
                        · {item.source.filename} · {item.source.sheet}!A
                        {item.source.row}:L{item.source.row}
                        <p>
                          {fieldNames.room}: {item.normalized.room ?? "—"};{" "}
                          {fieldNames.weekly_hours}:{" "}
                          {item.normalized.weekly_hours ?? "—"}
                        </p>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p>{im.noHistory}</p>
                )}
              </details>
            </section>
          )}
          <section className="panel import-apply" aria-labelledby="apply-title">
            <h2 id="apply-title">3. {im.apply}</h2>
            {batch.status === "applied" ? (
              <p role="status" className="notice">
                {im.appliedNotice}
              </p>
            ) : (
              <>
                <p>{im.applyWarning}</p>
                {batch.summary.duplicate_rows > 0 && (
                  <p className="import-question-note">{im.duplicateNotice}</p>
                )}
                {canWrite && (
                  <>
                    <label className="import-check">
                      <input
                        type="checkbox"
                        checked={confirmed}
                        disabled={busy || dirty || batch.stale}
                        onChange={(event) => setConfirmed(event.target.checked)}
                      />
                      {im.confirmApply}
                    </label>
                    <button
                      className="button button-primary"
                      disabled={busy || dirty || !confirmed || batch.stale}
                      onClick={() =>
                        void act(async () => {
                          const result = await mutate((token) =>
                            importsApi.apply(batch.id, batch.revision, token),
                          );
                          setBatch(result);
                          resetRow();
                          setConfirmed(false);
                          setItems(await importsApi.list(scope));
                        })
                      }
                    >
                      {im.applyButton}
                    </button>
                  </>
                )}
              </>
            )}
          </section>
        </>
      )}
    </section>
  );
}
