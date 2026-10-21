import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { editorApi } from "./editor-api";
import type {
  DraftOccurrence,
  DraftSeries,
  DraftView,
  EditorData,
  ScheduleDraft,
  SeriesValues,
} from "./editor-api";
import { calendarErrors } from "./locales/calendar.kk";
import { em, editorMessages } from "./locales/editor.kk";
import { SeriesForm } from "./editor/SeriesForm";
import { OneDateForm } from "./editor/OneDateForm";
import type { OneDateValues } from "./editor/OneDateForm";
import { RoomPanel } from "./editor/RoomPanel";
import { ConflictReport } from "./editor/ConflictReport";
import { demoName } from "./demo-labels";
import { vm, versionStatuses } from "./locales/publication.kk";
import type { VersionStatus } from "./publication-api";
import { PageHeading } from "./ui/PageHeading";
import { StatusBadge, statusTone } from "./ui/StatusBadge";
import "./editor.css";
import { WeekPanel } from "./timetable/WeekPanel";
import { wb } from "./locales/workbench.kk";

const emptyData: EditorData = {
  rooms: [],
  contexts: [],
  assignments: [],
  calendars: [],
  drafts: [],
};
const allDates = (): DraftView => ({
  start: "",
  end: "",
  view: "group",
  resource_id: "",
  offset: 0,
});
type Selection =
  | { mode: "new" }
  | { mode: "series"; series: DraftSeries }
  | { mode: "one"; event: DraftOccurrence }
  | null;

export function EditorPage({
  scope,
  csrfToken,
  canEdit,
  canRead,
  canManageRooms,
  initialDraftId,
  initialMode = "list",
  onOpenVersion,
  onExpired,
}: {
  scope: string;
  csrfToken: string;
  canEdit: boolean;
  canRead: boolean;
  canManageRooms: boolean;
  initialDraftId?: string;
  initialMode?: "week" | "list";
  onOpenVersion?: (id: string) => void;
  onExpired: () => void;
}) {
  const [mode, setMode] = useState(initialMode);
  const weekQuery = useRef<DraftView | null>(null);
  const [data, setData] = useState<EditorData>(emptyData);
  const [draft, setDraft] = useState<ScheduleDraft | null>(null);
  const [context, setContext] = useState("");
  const [name, setName] = useState("");
  const [selection, setSelection] = useState<Selection>(null);
  const [view, setView] = useState<DraftView>(allDates);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [remoteStale, setRemoteStale] = useState(false);
  const [csrf, setCsrf] = useState(csrfToken);
  useEffect(() => setCsrf(csrfToken), [csrfToken]);
  useEffect(() => {
    let active = true;
    void editorApi
      .data(scope)
      .then(async (loaded) => {
        if (!active) return;
        setData(loaded);
        setContext(loaded.contexts[0]?.id ?? "");
        if (canRead && loaded.drafts.length) {
          const first = await editorApi.get(
            initialDraftId ?? loaded.drafts[0].id,
          );
          if (active) setDraft(first);
        }
      })
      .catch((problem) => {
        if (active) fail(problem);
      });
    return () => {
      active = false;
    };
  }, [scope, canRead, initialDraftId]);
  useEffect(() => {
    if (!draft) return;
    let active = true;
    const check = () => {
      if (document.visibilityState !== "visible") return;
      void editorApi
        .get(draft.id)
        .then((fresh) => {
          if (
            active &&
            (fresh.revision !== draft.revision ||
              fresh.status !== draft.status ||
              JSON.stringify(fresh.dependencies) !==
                JSON.stringify(draft.dependencies))
          ) {
            setRemoteStale(true);
            setNotice("");
          }
        })
        .catch((problem) => {
          if (active && problem instanceof ApiError && problem.status === 401)
            onExpired();
        });
    };
    document.addEventListener("visibilitychange", check);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", check);
    };
  }, [draft, onExpired]);
  function fail(problem: unknown) {
    if (problem instanceof ApiError && problem.status === 401) onExpired();
    else {
      setError(
        problem instanceof ApiError
          ? (editorMessages[problem.code] ??
              calendarErrors[problem.code] ??
              em.error)
          : em.error,
      );
      if (problem instanceof ApiError && problem.code === "EDITOR_STALE")
        setRemoteStale(true);
    }
  }
  async function act(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (problem) {
      fail(problem);
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
      const fresh = await api.session();
      if (!fresh.user) throw new ApiError(401, "AUTH_REQUIRED");
      setCsrf(fresh.csrf_token);
      return action(fresh.csrf_token);
    }
  }
  function accepted(value: ScheduleDraft) {
    setDraft(value);
    setSelection(null);
    setRemoteStale(false);
    setView(allDates());
    setData((current) => ({
      ...current,
      drafts: [
        {
          id: value.id,
          context_id: value.context_id,
          name: value.name,
          status: value.status,
          revision: value.revision,
        },
        ...current.drafts.filter((d) => d.id !== value.id),
      ],
    }));
    setNotice(em.saved);
  }
  function saveSeries(values: SeriesValues, id?: string) {
    if (draft)
      void act(async () =>
        accepted(
          await mutate((token) => editorApi.series(draft, values, token, id)),
        ),
      );
  }
  function saveOne(values: OneDateValues) {
    if (draft && selection?.mode === "one")
      void act(async () =>
        accepted(
          await mutate((token) =>
            editorApi.one(draft, selection.event, values, token),
          ),
        ),
      );
  }
  const editable =
    canEdit && draft?.status === "draft" && !busy && !remoteStale;
  const resources = !draft
    ? []
    : view.view === "room"
      ? data.rooms
          .filter((r) => r.data_kind === draft.data_kind)
          .map((r) => [r.id, r.code])
      : [
          ...new Map(
            data.assignments
              .filter((a) => a.context_id === draft.context_id)
              .map((a) => [
                view.view === "group" ? a.group_id : a.teacher_id,
                view.view === "group" ? a.group : a.teacher,
              ]),
          ).entries(),
        ];
  function acceptView(loaded: ScheduleDraft) {
    if (
      selection &&
      draft &&
      (loaded.revision !== draft.revision ||
        loaded.status !== draft.status ||
        JSON.stringify(loaded.dependencies) !==
          JSON.stringify(draft.dependencies))
    ) {
      setRemoteStale(true);
      setError(em.stale);
      return;
    }
    setDraft(loaded);
  }
  return (
    <section
      className={`editor-page ${mode === "week" ? "week-mode" : ""}`}
      aria-labelledby="editor-title"
      aria-busy={busy}
    >
      <div className="schedule-page-heading">
        <PageHeading
          id="editor-title"
          eyebrow={em.eyebrow}
          title={canRead ? (mode === "week" ? wb.weekly : em.title) : em.rooms}
          description={
            canRead
              ? mode === "week" && draft
                ? draft.data_kind === "synthetic"
                  ? wb.demo
                  : draft.academic_year
                : em.intro
              : em.roomHint
          }
        />
        {canRead && (
          <div className="schedule-display-toggle" aria-label="Кесте пішімі">
            <button
              className="button button-quiet"
              aria-pressed={mode === "week"}
              disabled={busy || !!selection}
              onClick={() => {
                weekQuery.current = view;
                setMode("week");
              }}
            >
              {wb.week}
            </button>
            <button
              className="button button-quiet"
              aria-pressed={mode === "list"}
              disabled={busy || !!selection}
              onClick={() => {
                if (mode === "week" && draft && weekQuery.current)
                  void act(async () => {
                    const next = weekQuery.current!;
                    acceptView(await editorApi.get(draft.id, next));
                    setView(next);
                    setMode("list");
                  });
                else setMode("list");
              }}
            >
              {wb.list}
            </button>
          </div>
        )}
      </div>
      <div className="editor-feedback" aria-live="polite">
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
      </div>
      {remoteStale && <p className="notice editor-stale">{em.stale}</p>}
      {canManageRooms && (
        <RoomPanel
          key={data.rooms.map((r) => `${r.id}:${r.revision}`).join(",")}
          rooms={data.rooms}
          busy={busy}
          onSave={(values, room) =>
            act(async () => {
              const saved = await mutate((token) =>
                editorApi.room(scope, values, token, room),
              );
              setData((current) => ({
                ...current,
                rooms: [
                  saved,
                  ...current.rooms.filter((r) => r.id !== saved.id),
                ],
              }));
              setNotice(em.saved);
            })
          }
        />
      )}
      {canRead && (
        <>
          {!canEdit && <p className="notice editor-stale">{em.readonly}</p>}
          <div className="editor-toolbar">
            <label>
              {em.draft}
              <select
                value={draft?.id ?? ""}
                disabled={busy}
                onChange={(e) => {
                  const id = e.target.value;
                  if (id)
                    void act(async () => {
                      const loaded = await editorApi.get(id);
                      setDraft(loaded);
                      setSelection(null);
                      setView(allDates());
                      setRemoteStale(false);
                    });
                }}
              >
                <option value="">{em.noDraft}</option>
                {data.drafts.map((d) => (
                  <option key={d.id} value={d.id}>
                    {demoName(
                      d.name,
                      data.contexts.find((c) => c.id === d.context_id)
                        ?.data_kind,
                    )}{" "}
                    · {em.revision} {d.revision}
                  </option>
                ))}
              </select>
            </label>
            {draft && (
              <button
                type="button"
                className="button button-quiet"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const loadedData = await editorApi.data(scope);
                    const loadedDraft = await editorApi.get(draft.id);
                    setData(loadedData);
                    setDraft(loadedDraft);
                    setSelection(null);
                    setView(allDates());
                    setRemoteStale(false);
                  })
                }
              >
                {em.reload}
              </button>
            )}
          </div>
          {canEdit && (
            <details className="editor-panel" open={!draft}>
              <summary>{em.createDraft}</summary>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(async () =>
                    accepted(
                      await mutate((token) =>
                        editorApi.create(scope, context, name, token),
                      ),
                    ),
                  );
                }}
              >
                <div className="editor-grid">
                  <label>
                    {em.context}
                    <select
                      value={context}
                      required
                      disabled={busy}
                      onChange={(e) => setContext(e.target.value)}
                    >
                      <option value="">—</option>
                      {data.contexts.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.academic_year} ·{" "}
                          {c.data_kind === "synthetic"
                            ? em.synthetic
                            : em.college}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {em.draftName}
                    <input
                      value={name}
                      required
                      maxLength={160}
                      disabled={busy}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </label>
                </div>
                {!data.contexts.length && (
                  <p className="notice">{em.noContext}</p>
                )}
                <button
                  className="button button-primary"
                  disabled={busy || !context}
                >
                  {em.createDraft}
                </button>
              </form>
            </details>
          )}
          {draft && (
            <>
              <div className="editor-draft-heading">
                <div>
                  <div className="editor-version-identity">
                    <h2>
                      {mode === "week" && draft.version_number
                        ? `${vm.number} ${draft.version_number}`
                        : demoName(draft.name, draft.data_kind)}
                    </h2>
                    {mode === "week" && (
                      <StatusBadge tone={statusTone("version", draft.status)}>
                        {Object.hasOwn(versionStatuses, draft.status)
                          ? versionStatuses[draft.status as VersionStatus]
                          : vm.error}
                      </StatusBadge>
                    )}
                  </div>
                  <p>
                    {draft.academic_year} ·{" "}
                    {mode === "list" && (
                      <>
                        {draft.data_kind === "synthetic"
                          ? em.synthetic
                          : em.college}{" "}
                        ·{" "}
                        {draft.version_number && (
                          <>
                            {vm.number} {draft.version_number} ·{" "}
                          </>
                        )}
                      </>
                    )}
                    {em.revision} {draft.revision}
                  </p>
                </div>
                {onOpenVersion && (
                  <button
                    className="button button-quiet"
                    disabled={busy}
                    onClick={() => {
                      if (!selection || window.confirm(vm.leaveDirty))
                        onOpenVersion(draft.id);
                    }}
                  >
                    {vm.title}
                  </button>
                )}
                {canEdit && (
                  <button
                    className="button button-primary"
                    disabled={!editable}
                    onClick={() => {
                      setSelection({ mode: "new" });
                      setNotice("");
                    }}
                  >
                    {em.createSeries}
                  </button>
                )}
              </div>
              {mode === "list" ? (
                <div className="editor-version-state">
                  <StatusBadge tone={statusTone("version", draft.status)}>
                    {Object.hasOwn(versionStatuses, draft.status)
                      ? versionStatuses[draft.status as VersionStatus]
                      : vm.error}
                  </StatusBadge>
                  {draft.status !== "draft" && <p>{vm.readonly}</p>}
                </div>
              ) : (
                draft.status !== "draft" && (
                  <p className="editor-version-state">{vm.readonly}</p>
                )
              )}
              {draft.stale && (
                <p className="notice editor-stale">{em.reviewSources}</p>
              )}
              {selection?.mode === "new" && (
                <SeriesForm
                  key="new"
                  draft={draft}
                  data={data}
                  busy={busy || remoteStale}
                  onSave={saveSeries}
                  onClose={() => setSelection(null)}
                />
              )}
              {selection?.mode === "series" && (
                <SeriesForm
                  key={selection.series.id}
                  draft={draft}
                  data={data}
                  selected={selection.series}
                  busy={busy || remoteStale}
                  onSave={saveSeries}
                  onClose={() => setSelection(null)}
                />
              )}
              {mode === "list" && selection?.mode === "one" && (
                <OneDateForm
                  key={selection.event.id}
                  event={selection.event}
                  data={data}
                  kind={draft.data_kind}
                  busy={busy || remoteStale}
                  onSave={saveOne}
                  onClose={() => setSelection(null)}
                />
              )}
              {mode === "week" && (
                <WeekPanel
                  key={draft.id}
                  source={{ kind: "draft", value: draft, data }}
                  initialFilter={weekQuery.current ?? view}
                  onQuery={(query) => {
                    weekQuery.current = query;
                  }}
                  canEdit={editable}
                  onExpired={onExpired}
                  onStale={() => setRemoteStale(true)}
                  onEdit={(event) => {
                    setSelection({ mode: "one", event });
                    setNotice("");
                  }}
                  onCloseEditor={() => setSelection(null)}
                  editor={
                    selection?.mode === "one" ? (
                      <OneDateForm
                        key={selection.event.id}
                        event={selection.event}
                        data={data}
                        kind={draft.data_kind}
                        busy={busy || remoteStale}
                        onSave={saveOne}
                        onClose={() => setSelection(null)}
                      />
                    ) : undefined
                  }
                />
              )}
              {mode === "list" && (
                <section className="editor-panel">
                  <h2>{em.view}</h2>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void act(async () => {
                        const loaded = await editorApi.get(draft.id, {
                          ...view,
                          offset: 0,
                        });
                        acceptView(loaded);
                        setView((v) => ({ ...v, offset: 0 }));
                      });
                    }}
                  >
                    <div className="editor-grid">
                      <label>
                        {em.start}
                        <input
                          type="date"
                          value={view.start}
                          onChange={(e) =>
                            setView({ ...view, start: e.target.value })
                          }
                        />
                      </label>
                      <label>
                        {em.end}
                        <input
                          type="date"
                          value={view.end}
                          onChange={(e) =>
                            setView({ ...view, end: e.target.value })
                          }
                        />
                      </label>
                      <label>
                        {em.view}
                        <select
                          value={view.view}
                          onChange={(e) =>
                            setView({
                              ...view,
                              view: e.target.value as DraftView["view"],
                              resource_id: "",
                            })
                          }
                        >
                          {Object.entries(em.views).map(([key, label]) => (
                            <option key={key} value={key}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        {em.resource}
                        <select
                          value={view.resource_id}
                          onChange={(e) =>
                            setView({ ...view, resource_id: e.target.value })
                          }
                        >
                          <option value="">{em.all}</option>
                          {resources.map(([id, label]) => (
                            <option key={id} value={id}>
                              {demoName(label, draft.data_kind)}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <button
                      className="button button-quiet"
                      disabled={busy || remoteStale}
                    >
                      {em.show}
                    </button>
                  </form>
                  <div
                    className="editor-table-wrap"
                    role="region"
                    aria-label={em.title}
                    tabIndex={0}
                  >
                    <table className="editor-events-table">
                      <caption>
                        {demoName(draft.name, draft.data_kind)} · {em.revision}{" "}
                        {draft.revision}
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">{em.date}</th>
                          <th scope="col">{em.time}</th>
                          <th scope="col">{em.group}</th>
                          <th scope="col">{em.subject}</th>
                          <th scope="col">{em.teacher}</th>
                          <th scope="col">{em.room}</th>
                          <th scope="col">{em.status}</th>
                          {canEdit && <th scope="col">{em.actions}</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {draft.occurrences.map((e) => (
                          <tr
                            key={e.id}
                            className={
                              e.cancelled ? "editor-row-cancelled" : ""
                            }
                          >
                            <td>{e.date}</td>
                            <td>
                              {e.start}–{e.end}
                            </td>
                            <td>{demoName(e.group, draft.data_kind)}</td>
                            <td>
                              {demoName(e.subject, draft.data_kind)}
                              <small>
                                {em.source}: {e.source_coordinate}
                              </small>
                            </td>
                            <td>{demoName(e.teacher, draft.data_kind)}</td>
                            <td>{demoName(e.room, draft.data_kind)}</td>
                            <td>
                              <StatusBadge
                                tone={e.cancelled ? "neutral" : "info"}
                              >
                                {e.cancelled ? em.cancelled : em.active}
                              </StatusBadge>
                              {e.pinned && <small>{em.pinned}</small>}
                            </td>
                            {canEdit && (
                              <td>
                                <button
                                  className="editor-link"
                                  disabled={!editable}
                                  onClick={() => {
                                    setSelection({ mode: "one", event: e });
                                    setNotice("");
                                  }}
                                >
                                  {em.oneEdit} · {e.date}
                                </button>
                                <button
                                  className="editor-link"
                                  disabled={!editable}
                                  onClick={() => {
                                    const selected = draft.series.find(
                                      (s) => s.id === e.series_id,
                                    );
                                    if (selected) {
                                      setSelection({
                                        mode: "series",
                                        series: selected,
                                      });
                                      setNotice("");
                                    }
                                  }}
                                >
                                  {em.seriesEdit}
                                </button>
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {!draft.occurrences.length && (
                    <p className="editor-help">{em.noEvents}</p>
                  )}
                  <div className="editor-pagination">
                    <button
                      className="button button-quiet"
                      disabled={busy || remoteStale || draft.offset === 0}
                      onClick={() =>
                        void act(async () => {
                          const offset = Math.max(
                            0,
                            draft.offset - draft.limit,
                          );
                          acceptView(
                            await editorApi.get(draft.id, { ...view, offset }),
                          );
                        })
                      }
                    >
                      {em.previous}
                    </button>
                    <span>
                      {draft.total ? draft.offset + 1 : 0}–
                      {Math.min(draft.offset + draft.limit, draft.total)} /{" "}
                      {draft.total}
                    </span>
                    <button
                      className="button button-quiet"
                      disabled={
                        busy ||
                        remoteStale ||
                        draft.offset + draft.limit >= draft.total
                      }
                      onClick={() =>
                        void act(async () =>
                          acceptView(
                            await editorApi.get(draft.id, {
                              ...view,
                              offset: draft.offset + draft.limit,
                            }),
                          ),
                        )
                      }
                    >
                      {em.next}
                    </button>
                  </div>
                </section>
              )}
              {!remoteStale && (
                <ConflictReport
                  report={draft.report}
                  dataKind={draft.data_kind}
                />
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
