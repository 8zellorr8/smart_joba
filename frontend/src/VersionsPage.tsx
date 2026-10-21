import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { demoName } from "./demo-labels";
import { planningApi } from "./planning-api";
import type { IndependentReport, PlanningData } from "./planning-api";
import { expectedVersion, versionApi } from "./publication-api";
import type {
  PublishCommand,
  PublicationReadiness,
  PublicationSelection,
  VersionDetail,
  VersionSummary,
} from "./publication-api";
import { readPending, savePending } from "./publication-pending";
import {
  publicationMessages,
  versionActions,
  versionStatuses,
  vm,
} from "./locales/publication.kk";
import { planningMessages, pm } from "./locales/planning.kk";
import { ValidationView } from "./planning/ValidationView";
import "./editor.css";
import "./planning.css";
import "./publication.css";

interface Props {
  scope: string;
  userId: string;
  csrfToken: string;
  canSubmit: boolean;
  canApprove: boolean;
  canReject: boolean;
  canPublish: boolean;
  canEdit: boolean;
  onExpired: () => void;
  onOpenDraft: (id: string) => void;
  onDirtyChange: (dirty: boolean) => void;
  initialVersionId?: string;
  onSelectedVersion?: (id: string) => void;
}
export function VersionsPage(props: Props) {
  const {
    scope,
    userId,
    canSubmit,
    canApprove,
    canReject,
    canPublish,
    canEdit,
    onOpenDraft,
    onDirtyChange,
  } = props;
  const [items, setItems] = useState<VersionSummary[]>([]);
  const [data, setData] = useState<PlanningData | null>(null);
  const [version, setVersion] = useState<VersionDetail | null>(null);
  const [selection, setSelection] = useState<PublicationSelection>({
    group_ids: [],
    room_ids: [],
    semester: 1,
  });
  const [comment, setComment] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dirty, setDirty] = useState(false);
  const [checked, setChecked] = useState<PublicationReadiness | null>(null);
  const [errorReport, setErrorReport] = useState<IndependentReport | null>(
    null,
  );
  const [pending, setPending] = useState<PublishCommand | null>(null);
  const initialFocus = useRef(props.initialVersionId);
  const csrf = useRef(props.csrfToken);
  const expired = useRef(props.onExpired);
  expired.current = props.onExpired;
  const pendingKey = (id: string) =>
    `smart-joba:publish:${userId}:${scope}:${id}`;

  const fail = (problem: unknown) => {
    if (problem instanceof ApiError && problem.status === 401) {
      setVersion(null);
      setData(null);
      setItems([]);
      setComment("");
      setName("");
      setDirty(false);
      expired.current();
      return;
    }
    setError(
      problem instanceof ApiError
        ? (publicationMessages[problem.code] ??
            planningMessages[problem.code] ??
            (problem.status === 0 ? pm.connection : vm.error))
        : vm.error,
    );
    if (
      problem instanceof ApiError &&
      problem.params.report &&
      typeof problem.params.report === "object" &&
      "valid" in problem.params.report &&
      "hours" in problem.params.report
    )
      setErrorReport(problem.params.report as IndependentReport);
  };
  function accept(value: VersionDetail) {
    props.onSelectedVersion?.(value.id);
    setVersion(value);
    setSelection(value.selection);
    setComment("");
    setName("");
    setDirty(false);
    setChecked(null);
    setErrorReport(null);
    setPending(readPending(pendingKey(value.id)));
    setItems((old) => [value, ...old.filter((v) => v.id !== value.id)]);
  }
  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    setErrorReport(null);
    try {
      await action();
    } catch (problem) {
      fail(problem);
    } finally {
      setBusy(false);
    }
  }
  async function mutate<T>(action: (token: string) => Promise<T>) {
    try {
      return await action(csrf.current);
    } catch (problem) {
      if (!(problem instanceof ApiError) || problem.code !== "CSRF_INVALID")
        throw problem;
      const session = await api.session();
      if (!session.user) throw new ApiError(401, "AUTH_REQUIRED");
      csrf.current = session.csrf_token;
      return action(csrf.current);
    }
  }
  useEffect(() => {
    let alive = true;
    setBusy(true);
    Promise.all([versionApi.list(scope), planningApi.data(scope)])
      .then(async ([list, options]) => {
        if (!alive) return;
        setItems(list);
        setData(options);
        if (list.length) {
          const value = await versionApi.get(
            list.find((v) => v.id === initialFocus.current)?.id ?? list[0].id,
          );
          if (alive) accept(value);
        }
      })
      .catch((problem) => {
        if (alive) fail(problem);
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [scope, userId]);
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [dirty]);
  const confirmDiscard = () => !dirty || window.confirm(vm.leaveDirty);
  const update = (changes: Partial<PublicationSelection>) => {
    setSelection((old) => ({ ...old, ...changes }));
    setDirty(true);
    setChecked(null);
  };
  const choose = (
    kind: "group_ids" | "room_ids",
    id: string,
    selected: boolean,
  ) =>
    update({
      [kind]: selected
        ? [...selection[kind], id]
        : selection[kind].filter((value) => value !== id),
    });

  async function publish() {
    if (!version || (!pending && !checked?.ready)) return;
    const command = pending ?? {
      ...expectedVersion(version),
      approval_id: checked!.approval_id,
      readiness_token: checked!.token,
      idempotency_key: crypto.randomUUID(),
    };
    setPending(command);
    savePending(pendingKey(version.id), command);
    try {
      await mutate((token) => versionApi.publish(version.id, command, token));
    } catch (problem) {
      // Transport/5xx, lock contention and lost authorization leave a prior
      // attempt uncertain. Keep its exact key/body for a later authorized retry.
      if (
        problem instanceof ApiError &&
        problem.status >= 400 &&
        problem.status < 500 &&
        problem.status !== 401 &&
        problem.status !== 403 &&
        problem.code !== "PUBLICATION_BUSY"
      ) {
        savePending(pendingKey(version.id), null);
        setPending(null);
        setChecked(null);
      }
      throw problem;
    }
    savePending(pendingKey(version.id), null);
    setPending(null);
    setChecked(null);
    setDirty(false);
    setNotice(vm.published);
    // The receipt already confirms success even if this subsequent read fails.
    try {
      const [current, list] = await Promise.all([
        versionApi.get(version.id),
        versionApi.list(scope),
      ]);
      setItems(list);
      accept(current);
    } catch (problem) {
      fail(problem);
    }
  }
  const kind = version?.data_kind;
  return (
    <section
      className="version-page"
      aria-labelledby="versions-title"
      aria-busy={busy}
    >
      <div className="page-heading">
        <p className="eyebrow">{vm.version}</p>
        <h1 id="versions-title">{vm.title}</h1>
        <p>{vm.intro}</p>
      </div>
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="planning-success">
          {notice}
        </p>
      )}
      <section className="editor-panel">
        <label>
          {vm.version}
          <select
            value={version?.id ?? ""}
            disabled={busy}
            onChange={(e) => {
              const id = e.target.value;
              if (confirmDiscard())
                void act(async () => accept(await versionApi.get(id)));
            }}
          >
            <option value="" disabled>
              {vm.choose}
            </option>
            {items.map((v) => (
              <option key={v.id} value={v.id}>
                {vm.number} {v.version_number} · {demoName(v.name, v.data_kind)}{" "}
                · {v.academic_year} · {versionStatuses[v.status]}
              </option>
            ))}
          </select>
        </label>
        <button
          className="button button-quiet"
          disabled={busy}
          onClick={() => {
            if (confirmDiscard())
              void act(async () => {
                const list = await versionApi.list(scope);
                setItems(list);
                if (version && list.some((v) => v.id === version.id))
                  accept(await versionApi.get(version.id));
                else if (list.length) accept(await versionApi.get(list[0].id));
                else setVersion(null);
              });
          }}
        >
          {vm.refresh}
        </button>
        {!busy && !items.length && <p>{vm.empty}</p>}
      </section>
      {version && (
        <>
          <section className="editor-panel">
            <h2>
              {vm.number} {version.version_number} ·{" "}
              {demoName(version.name, kind)}
            </h2>
            <p>
              {version.academic_year} ·{" "}
              {kind === "synthetic" ? pm.synthetic : pm.college}
            </p>
            <p role="status">
              {vm.status}: {versionStatuses[version.status]} · {vm.revision}:{" "}
              {version.revision} · {vm.workflow}: {version.workflow_revision}
            </p>
            {version.status !== "draft" && <p>{vm.readonly}</p>}
            {version.submission?.stale && (
              <p role="alert" className="planning-warning">
                {vm.stale}
              </p>
            )}
            {dirty && (
              <p role="status" className="planning-warning">
                {vm.dirty}
              </p>
            )}
            {pending && (
              <p role="status" className="planning-warning">
                {vm.pending}
              </p>
            )}
            <div className="version-actions">
              <button
                className="button button-quiet"
                disabled={busy}
                onClick={() => onOpenDraft(version.id)}
              >
                {vm.open}
              </button>
              <button
                className="button button-quiet"
                disabled={busy}
                onClick={() => {
                  if (confirmDiscard())
                    void act(async () =>
                      accept(await versionApi.get(version.id)),
                    );
                }}
              >
                {vm.reload}
              </button>
              {canEdit && version.status === "rejected" && (
                <button
                  className="button button-primary"
                  disabled={busy}
                  onClick={() =>
                    void act(async () =>
                      accept(
                        await mutate((token) =>
                          versionApi.reopen(version, token),
                        ),
                      ),
                    )
                  }
                >
                  {vm.reopen}
                </button>
              )}
            </div>
            {version.status === "draft" && canSubmit && (
              <fieldset disabled={busy || !!pending}>
                <legend>{vm.selectionHint}</legend>
                <h3>{vm.groups}</h3>
                <div className="planning-checks">
                  {data?.groups
                    .filter(
                      (g) =>
                        g.data_kind === kind &&
                        data.demands.some(
                          (d) =>
                            d.context_id === version.context_id &&
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
                        {demoName(g.code, kind)}
                      </label>
                    ))}
                </div>
                <h3>{vm.rooms}</h3>
                <div className="planning-checks">
                  {data?.rooms
                    .filter((r) => r.data_kind === kind)
                    .map((r) => (
                      <label key={r.id}>
                        <input
                          type="checkbox"
                          checked={selection.room_ids.includes(r.id)}
                          onChange={(e) =>
                            choose("room_ids", r.id, e.target.checked)
                          }
                        />
                        {demoName(r.code, kind)}
                      </label>
                    ))}
                </div>
                <label>
                  {vm.semester}
                  <input
                    type="number"
                    min="1"
                    max="20"
                    value={selection.semester}
                    onChange={(e) =>
                      update({ semester: Number(e.target.value) })
                    }
                  />
                </label>
                <div className="version-actions">
                  <button
                    className="button button-primary"
                    disabled={
                      !selection.group_ids.length ||
                      !selection.room_ids.length ||
                      !selection.semester
                    }
                    onClick={() =>
                      void act(async () =>
                        accept(
                          await mutate((token) =>
                            versionApi.submit(version, selection, token),
                          ),
                        ),
                      )
                    }
                  >
                    {vm.submit}
                  </button>
                </div>
              </fieldset>
            )}
            {version.status === "submitted" && (canApprove || canReject) && (
              <>
                <label>
                  {vm.reason}
                  <textarea
                    maxLength={2000}
                    value={comment}
                    disabled={busy}
                    onChange={(e) => {
                      setComment(e.target.value);
                      setDirty(true);
                    }}
                  />
                </label>
                <p>{vm.reasonHint}</p>
                <div className="version-actions">
                  {canApprove && (
                    <button
                      className="button button-primary"
                      disabled={busy}
                      onClick={() =>
                        void act(async () =>
                          accept(
                            await mutate((token) =>
                              versionApi.decide(
                                version,
                                "approve",
                                comment,
                                token,
                              ),
                            ),
                          ),
                        )
                      }
                    >
                      {vm.approve}
                    </button>
                  )}
                  {canReject && (
                    <button
                      className="button button-quiet"
                      disabled={busy || !comment.trim()}
                      onClick={() =>
                        void act(async () =>
                          accept(
                            await mutate((token) =>
                              versionApi.decide(
                                version,
                                "reject",
                                comment,
                                token,
                              ),
                            ),
                          ),
                        )
                      }
                    >
                      {vm.reject}
                    </button>
                  )}
                </div>
              </>
            )}
            {canPublish && (version.status === "approved" || pending) && (
              <div className="version-actions">
                {!pending && (
                  <button
                    className="button button-quiet"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        setChecked(null);
                        setChecked(await versionApi.readiness(version));
                      })
                    }
                  >
                    {vm.check}
                  </button>
                )}
                <button
                  className="button button-primary"
                  disabled={busy || (!pending && !checked?.ready)}
                  onClick={() => void act(publish)}
                >
                  {pending ? vm.retryPublish : vm.publish}
                </button>
              </div>
            )}
            {canEdit && (
              <details>
                <summary>{vm.fork}</summary>
                <p>{vm.forkHint}</p>
                <label>
                  {vm.forkName}
                  <input
                    maxLength={160}
                    value={name}
                    disabled={busy}
                    onChange={(e) => {
                      setName(e.target.value);
                      setDirty(true);
                    }}
                  />
                </label>
                <button
                  className="button button-quiet"
                  disabled={busy || !name.trim()}
                  onClick={() =>
                    void act(async () =>
                      accept(
                        await mutate((token) =>
                          versionApi.fork(version, name, token),
                        ),
                      ),
                    )
                  }
                >
                  {vm.fork}
                </button>
              </details>
            )}
          </section>
          {checked && (
            <section className="editor-panel">
              <h2>{checked.ready ? vm.ready : vm.blocked}</h2>
              {checked.issues.length > 0 && (
                <ul>
                  {checked.issues.map((issue, i) => (
                    <li key={i}>
                      {publicationMessages[issue.code] ?? vm.error}
                      {issue.date && ` · ${issue.date}`}{" "}
                      {issue.resource_name &&
                        ` · ${demoName(issue.resource_name, kind)}`}
                    </li>
                  ))}
                </ul>
              )}
              {checked.issues_truncated && <p role="alert">{pm.truncated}</p>}
            </section>
          )}
          {(errorReport || checked?.report || version.submission?.report) && (
            <ValidationView
              report={
                errorReport ?? checked?.report ?? version.submission!.report
              }
              dataKind={kind}
              stale={version.submission?.stale}
            />
          )}
          <section className="editor-panel">
            <h2>{vm.history}</h2>
            {version.history.length ? (
              <ol className="version-history">
                {version.history.map((h) => (
                  <li key={h.workflow_revision}>
                    <strong>{versionActions[h.action] ?? vm.status}</strong> ·{" "}
                    {h.actor} · {new Date(h.created_at).toLocaleString("kk-KZ")}
                    <p>
                      {vm.revision}: {h.revision} · {vm.workflow}:{" "}
                      {h.workflow_revision}
                    </p>
                    {h.comment && <p>{h.comment}</p>}
                  </li>
                ))}
              </ol>
            ) : (
              <p>{vm.noHistory}</p>
            )}
          </section>
        </>
      )}
    </section>
  );
}
