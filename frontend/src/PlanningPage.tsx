import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { planningApi } from "./planning-api";
import type {
  PlanningData,
  Preview,
  SavedReport,
  Selection,
  SolverJob,
} from "./planning-api";
import {
  pm,
  jobStages,
  jobStatuses,
  planningMessages,
} from "./locales/planning.kk";
import { Diagnostics, ValidationView } from "./planning/ValidationView";
import { demoName } from "./demo-labels";
import { RulesForm } from "./planning/RulesForm";
import { PageHeading } from "./ui/PageHeading";
import { StatusBadge, statusTone } from "./ui/StatusBadge";
import "./editor.css";
import "./planning.css";

const activeJob = (job: SolverJob | null) =>
  !!job && ["queued", "running"].includes(job.execution_status);
const initialSelection = (): Selection => ({
  context_id: "",
  group_ids: [],
  room_ids: [],
  semester: 1,
  base_draft_id: null,
});
export function PlanningPage({
  scope,
  csrfToken,
  canRun,
  canRead,
  canManage,
  onExpired,
  onOpenDraft,
  onDirtyChange,
}: {
  scope: string;
  csrfToken: string;
  canRun: boolean;
  canRead: boolean;
  canManage: boolean;
  onExpired: () => void;
  onOpenDraft: (id: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [data, setData] = useState<PlanningData | null>(null);
  const [selection, setSelection] = useState<Selection>(initialSelection);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [seconds, setSeconds] = useState(30);
  const [jobs, setJobs] = useState<SolverJob[]>([]);
  const [job, setJob] = useState<SolverJob | null>(null);
  const [jobId, setJobId] = useState("");
  const [draftId, setDraftId] = useState("");
  const [reports, setReports] = useState<SavedReport[]>([]);
  const [reportsLoading, setReportsLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [checkedAt, setCheckedAt] = useState("");
  const [csrf, setCsrf] = useState(csrfToken);
  const expiredRef = useRef(onExpired);
  useEffect(() => {
    expiredRef.current = onExpired;
  }, [onExpired]);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => setCsrf(csrfToken), [csrfToken]);
  const fail = useCallback((problem: unknown) => {
    if (problem instanceof ApiError && problem.status === 401)
      expiredRef.current();
    else
      setError(
        problem instanceof ApiError
          ? (planningMessages[problem.code] ??
              (problem.status === 0 ? pm.connection : pm.error))
          : pm.error,
      );
  }, []);
  useEffect(() => {
    let live = true;
    void Promise.all([
      planningApi.data(scope),
      canRead ? planningApi.jobs(scope) : Promise.resolve([]),
    ])
      .then(([loaded, list]) => {
        if (!live) return;
        setData(loaded);
        setSelection((s) => ({
          ...s,
          context_id: loaded.contexts[0]?.id ?? "",
        }));
        setJobs(list);
        const remembered = localStorage.getItem(`smart-joba-job:${scope}`);
        setJobId(
          list.find((j) => j.id === remembered)?.id ?? list[0]?.id ?? "",
        );
      })
      .catch((problem) => {
        if (live) fail(problem);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [scope, canRead, fail]);
  useEffect(() => {
    if (!jobId) {
      setJob(null);
      return;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    localStorage.setItem(`smart-joba-job:${scope}`, jobId);
    const poll = async () => {
      try {
        const result = await planningApi.job(jobId);
        if (!live) return;
        setJob(result);
        setCheckedAt(new Date().toLocaleTimeString("kk-KZ"));
        setJobs((list) => [result, ...list.filter((j) => j.id !== result.id)]);
        timer = setTimeout(() => void poll(), activeJob(result) ? 1000 : 5000);
      } catch (problem) {
        if (live) {
          fail(problem);
          timer = setTimeout(() => void poll(), 3000);
        }
      }
    };
    setJob(null);
    void poll();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [jobId, scope, fail]);
  useEffect(() => {
    let live = true;
    setReports([]);
    setReportsLoading(!!draftId);
    if (draftId)
      void planningApi
        .reports(draftId)
        .then((r) => {
          if (live) setReports(r);
        })
        .catch((problem) => {
          if (live) fail(problem);
        })
        .finally(() => {
          if (live) setReportsLoading(false);
        });
    return () => {
      live = false;
    };
  }, [draftId, fail]);
  async function mutate<T>(
    operation: (token: string) => Promise<T>,
  ): Promise<T> {
    try {
      return await operation(csrf);
    } catch (problem) {
      if (!(problem instanceof ApiError) || problem.code !== "CSRF_INVALID")
        throw problem;
      const refreshed = await api.session();
      if (!refreshed.user) {
        onExpired();
        throw problem;
      }
      setCsrf(refreshed.csrf_token);
      return operation(refreshed.csrf_token);
    }
  }
  async function act(operation: () => Promise<void>, rethrow = false) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
    } catch (problem) {
      fail(problem);
      if (rethrow) throw problem;
    } finally {
      setBusy(false);
    }
  }
  const updateSelection = (change: Partial<Selection>) => {
    setSelection((s) => ({ ...s, ...change }));
    setPreview(null);
  };
  const context = data?.contexts.find((c) => c.id === selection.context_id);
  const validSelection =
    !!context && !!selection.group_ids.length && !!selection.room_ids.length;
  const choices =
    data?.drafts.filter((d) => d.context_id === context?.id) ?? [];
  const choose = (
    key: "group_ids" | "room_ids",
    id: string,
    checked: boolean,
  ) =>
    updateSelection({
      [key]: checked
        ? [...selection[key], id]
        : selection[key].filter((v) => v !== id),
    });
  if (loading) return <p role="status">{pm.loading}</p>;
  return (
    <section
      className="planning-page"
      aria-labelledby="planning-title"
      aria-busy={busy}
    >
      <PageHeading
        id="planning-title"
        eyebrow={canManage ? pm.conditions : pm.subtitle}
        title={canManage ? pm.conditions : pm.title}
        description={pm.intro}
      />
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      {!data || !data.contexts.length ? (
        <p>{pm.empty}</p>
      ) : (
        <>
          <div className="editor-panel">
            <label>
              {pm.context}
              <select
                disabled={busy || dirty}
                value={selection.context_id}
                onChange={(e) => {
                  updateSelection({
                    ...initialSelection(),
                    context_id: e.target.value,
                  });
                  setDraftId("");
                }}
              >
                {data.contexts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.academic_year} ·{" "}
                    {c.data_kind === "synthetic" ? pm.synthetic : pm.college}
                  </option>
                ))}
              </select>
            </label>
            {context && (
              <p
                className={
                  context.data_kind === "synthetic" ? "planning-warning" : ""
                }
              >
                {context.data_kind === "synthetic" ? pm.synthetic : pm.college}{" "}
                · {pm.revision} {context.revision}
              </p>
            )}
            <button
              type="button"
              className="button button-quiet"
              disabled={busy || dirty}
              onClick={() =>
                void act(async () => {
                  const loaded = await planningApi.data(scope);
                  setData(loaded);
                  setPreview(null);
                  if (canRead) setJobs(await planningApi.jobs(scope));
                  if (draftId) setReports(await planningApi.reports(draftId));
                })
              }
            >
              {pm.reload}
            </button>
          </div>
          {canManage && context && (
            <RulesForm
              key={`${context.id}:${context.rules_revision}`}
              data={data}
              context={context}
              busy={busy}
              onDirty={setDirty}
              onSave={(document) =>
                act(async () => {
                  const result = await mutate((token) =>
                    planningApi.rules(
                      context.id,
                      context.rules_revision,
                      document,
                      token,
                    ),
                  );
                  setData(
                    (d) =>
                      d && {
                        ...d,
                        contexts: d.contexts.map((c) =>
                          c.id === context.id
                            ? {
                                ...c,
                                rules: result.document,
                                rules_revision: result.revision,
                              }
                            : c,
                        ),
                      },
                  );
                  setNotice(pm.saved);
                }, true)
              }
            />
          )}
          {canRead && (
            <>
              <section className="editor-panel">
                <h2>{pm.groups}</h2>
                <p>{pm.scopeHint}</p>
                <fieldset disabled={busy}>
                  <div className="planning-checks">
                    {data.groups
                      .filter(
                        (g) =>
                          g.data_kind === context?.data_kind &&
                          data.demands.some(
                            (d) =>
                              d.context_id === context?.id &&
                              d.group_id === g.id,
                          ),
                      )
                      .map((g) => (
                        <label key={g.id}>
                          <input
                            type="checkbox"
                            checked={selection.group_ids.includes(g.id)}
                            onChange={(e) =>
                              choose("group_ids", g.id, e.target.checked)
                            }
                          />
                          {demoName(g.code, g.data_kind)}
                        </label>
                      ))}
                  </div>
                  <h3>{pm.rooms}</h3>
                  <div className="planning-checks">
                    {data.rooms
                      .filter((r) => r.data_kind === context?.data_kind)
                      .map((r) => (
                        <label key={r.id}>
                          <input
                            type="checkbox"
                            checked={selection.room_ids.includes(r.id)}
                            onChange={(e) =>
                              choose("room_ids", r.id, e.target.checked)
                            }
                          />
                          {demoName(r.code, r.data_kind)}
                        </label>
                      ))}
                  </div>
                  <div className="planning-input-grid">
                    <label>
                      {pm.semester}
                      <input
                        type="number"
                        min="1"
                        max="20"
                        value={selection.semester}
                        onChange={(e) =>
                          updateSelection({ semester: Number(e.target.value) })
                        }
                      />
                    </label>
                    {canRun && (
                      <>
                        <label>
                          {pm.base}
                          <select
                            value={selection.base_draft_id ?? ""}
                            onChange={(e) =>
                              updateSelection({
                                base_draft_id: e.target.value || null,
                              })
                            }
                          >
                            <option value="">{pm.noBase}</option>
                            {choices.map((d) => (
                              <option key={d.id} value={d.id}>
                                {demoName(d.name, context?.data_kind)} ·{" "}
                                {d.revision}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          {pm.seconds}
                          <input
                            type="number"
                            min="1"
                            max="30"
                            value={seconds}
                            onChange={(e) => setSeconds(Number(e.target.value))}
                          />
                        </label>
                      </>
                    )}
                  </div>
                </fieldset>
                {canRun && (
                  <>
                    <div className="editor-actions">
                      <button
                        className="button button-quiet"
                        disabled={busy || !validSelection}
                        onClick={() =>
                          void act(async () =>
                            setPreview(
                              await mutate((token) =>
                                planningApi.preview(scope, selection, token),
                              ),
                            ),
                          )
                        }
                      >
                        {pm.preview}
                      </button>
                      <button
                        className="button button-primary"
                        disabled={
                          busy ||
                          !validSelection ||
                          !preview?.ready ||
                          activeJob(job)
                        }
                        onClick={() =>
                          void act(async () => {
                            if (!preview) return;
                            const created = await mutate((token) =>
                              planningApi.create(
                                scope,
                                selection,
                                preview.token,
                                seconds,
                                token,
                              ),
                            );
                            setJobs((v) => [created, ...v]);
                            setJobId(created.id);
                            setPreview(null);
                          })
                        }
                      >
                        {pm.start}
                      </button>
                    </div>
                    {preview && (
                      <div role="status">
                        <h3>{preview.ready ? pm.ready : pm.blocked}</h3>
                        <p>
                          {pm.count}: {preview.demands} · {pm.pins}:{" "}
                          {preview.pins}
                        </p>
                        {!preview.external_verified && (
                          <p className="planning-warning">
                            {pm.externalUnknown}
                          </p>
                        )}
                        <Diagnostics
                          items={preview.questions}
                          dataKind={context?.data_kind}
                        />
                      </div>
                    )}
                  </>
                )}
              </section>
              <section className="editor-panel">
                <h2>{pm.jobs}</h2>
                {jobs.length ? (
                  <label>
                    {pm.job}
                    <select
                      value={jobId}
                      disabled={busy}
                      onChange={(e) => setJobId(e.target.value)}
                    >
                      {jobs.map((j) => (
                        <option key={j.id} value={j.id} title={j.id}>
                          {new Date(j.created_at).toLocaleString("kk-KZ")} ·{" "}
                          {jobStatuses[j.status] ?? pm.error}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <p>{pm.noJobs}</p>
                )}
                {job && (
                  <div>
                    <p role="status" className="planning-job-status">
                      <StatusBadge tone={statusTone("solver", job.status)}>
                        {jobStatuses[job.status] ?? pm.error}
                      </StatusBadge>
                    </p>
                    <p>
                      {pm.stage}: {jobStages[job.stage] ?? pm.error} ·{" "}
                      {pm.elapsed}: {job.elapsed_seconds}
                    </p>
                    <p>
                      {pm.checked}: {checkedAt}
                    </p>
                    <p>
                      {job.academic_year} ·{" "}
                      {job.data_kind === "synthetic"
                        ? pm.synthetic
                        : pm.college}{" "}
                      · {pm.semester}: {job.semester} · {pm.groups}:{" "}
                      {job.group_ids.length}
                    </p>
                    <details>
                      <summary>{pm.technicalDetails}</summary>
                      <p>
                        {job.algorithm_version} · {job.id}
                      </p>
                    </details>
                    {job.execution_status === "queued" && (
                      <p>{pm.queuedHint}</p>
                    )}
                    {job.stale && (
                      <p role="alert" className="planning-warning">
                        {pm.stale}
                      </p>
                    )}
                    {canRun && activeJob(job) && (
                      <button
                        className="button button-quiet"
                        disabled={busy || job.cancel_requested}
                        onClick={() =>
                          void act(async () =>
                            setJob(
                              await mutate((token) =>
                                planningApi.cancel(job.id, token),
                              ),
                            ),
                          )
                        }
                      >
                        {job.cancel_requested ? pm.cancelling : pm.cancel}
                      </button>
                    )}
                    {job.result_draft_id && !job.stale && (
                      <button
                        className="button button-primary"
                        onClick={() => onOpenDraft(job.result_draft_id!)}
                      >
                        {pm.open}
                      </button>
                    )}
                    {!!job.result?.diagnostics?.length && (
                      <details>
                        <summary>{pm.questions}</summary>
                        <Diagnostics
                          items={job.result.diagnostics}
                          dataKind={job.data_kind}
                        />
                      </details>
                    )}
                    {job.result?.validation && (
                      <ValidationView
                        report={job.result.validation}
                        dataKind={job.data_kind}
                        stale={job.stale || job.validation_stale}
                      />
                    )}
                  </div>
                )}
              </section>
              <section className="editor-panel">
                <h2>{pm.validate}</h2>
                <p>{pm.validateHint}</p>
                <label>
                  {pm.draft}
                  <select
                    value={draftId}
                    disabled={busy}
                    onChange={(e) => setDraftId(e.target.value)}
                  >
                    <option value="">—</option>
                    {choices.map((d) => (
                      <option key={d.id} value={d.id}>
                        {demoName(d.name, context?.data_kind)} · {pm.revision}{" "}
                        {d.revision}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="button button-primary"
                  disabled={
                    busy || reportsLoading || !draftId || !validSelection
                  }
                  onClick={() =>
                    void act(async () => {
                      const draft = choices.find((d) => d.id === draftId);
                      if (!draft) return;
                      const result = await mutate((token) =>
                        planningApi.validate(
                          draftId,
                          draft.revision,
                          selection,
                          token,
                        ),
                      );
                      setReports((v) => [result, ...v]);
                    })
                  }
                >
                  {pm.check}
                </button>
                {!!reports.length && <h3>{pm.reports}</h3>}
                {reports.map((r) => (
                  <ValidationView
                    key={r.id}
                    report={r.report}
                    dataKind={context?.data_kind}
                    stale={r.stale}
                  />
                ))}
              </section>
            </>
          )}
        </>
      )}
    </section>
  );
}
