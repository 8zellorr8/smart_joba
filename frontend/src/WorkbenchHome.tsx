import { useEffect, useRef, useState } from "react";
import type { Workspace } from "./api";
import { ApiError } from "./api";
import { publicationApi, versionApi } from "./publication-api";
import type {
  PublishedSummary,
  ReaderEvent,
  VersionSummary,
} from "./publication-api";
import { demoName } from "./demo-labels";
import { Icon } from "./icons";
import { wb } from "./locales/workbench.kk";
import { vm, versionStatuses } from "./locales/publication.kk";
import { messages as t } from "./locales/kk";
import { StatusBadge, statusTone } from "./ui/StatusBadge";
import { dayLabel, todayInZone } from "./timetable/dates";
import { collectWeek } from "./timetable/pages";
import { subjectTone } from "./timetable/WeekPanel";

export type WorkbenchDestination =
  "import" | "calendar" | "editor" | "planning" | "versions" | "publications";
export function WorkbenchHome({
  workspace,
  onNavigate,
  onOpenDraft,
  onOpenPublication,
  onExpired,
}: {
  workspace: Workspace;
  onNavigate: (view: WorkbenchDestination) => void;
  onOpenDraft: (id: string) => void;
  onOpenPublication: (
    id: string | undefined,
    date: string,
    group: string,
  ) => void;
  onExpired: () => void;
}) {
  const canRead = workspace.permissions.some((p) =>
    p.startsWith("publication.read"),
  );
  const canDraft = workspace.permissions.includes("draft.read");
  const [publications, setPublications] = useState<PublishedSummary[]>([]);
  const [publicationId, setPublicationId] = useState("");
  const [draft, setDraft] = useState<VersionSummary | null>(null);
  const [draftBusy, setDraftBusy] = useState(canDraft);
  const scopeSeen = useRef<string | null>(null);
  const lastSelection = useRef({ publicationId: "", date: "", group: "" });
  const [draftError, setDraftError] = useState("");
  const [date, setDate] = useState(() =>
    todayInZone(Intl.DateTimeFormat().resolvedOptions().timeZone),
  );
  const [group, setGroup] = useState("");
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  const [events, setEvents] = useState<ReaderEvent[]>([]);
  const [busy, setBusy] = useState(canRead);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const expired = useRef(onExpired);
  expired.current = onExpired;
  lastSelection.current = { publicationId, date, group };
  const source = publications.find((p) => p.publication_id === publicationId);
  useEffect(() => {
    let active = true;
    const previous =
      scopeSeen.current === workspace.scope.id ? lastSelection.current : null;
    scopeSeen.current = workspace.scope.id;
    setDraftBusy(canDraft);
    setPublications([]);
    setPublicationId("");
    setEvents([]);
    setGroups([]);
    setGroup("");
    setDraft(null);
    setDraftError("");
    setError("");
    if (canDraft)
      void versionApi
        .list(workspace.scope.id)
        .then((versions) => {
          if (active)
            setDraft(
              versions.find((v) => v.status === "draft") ?? versions[0] ?? null,
            );
        })
        .catch((problem) => {
          if (!active) return;
          if (problem instanceof ApiError && problem.status === 401)
            expired.current();
          setDraftError(wb.error);
        })
        .finally(() => {
          if (active) setDraftBusy(false);
        });
    if (canRead) {
      setBusy(true);
      void publicationApi
        .list(workspace.scope.id)
        .then((items) => {
          if (!active) return;
          const current = items.filter((p) => p.is_current);
          setPublications(current);
          const chosen =
            current.find((p) => p.publication_id === previous?.publicationId) ??
            current[0];
          setPublicationId(chosen?.publication_id ?? "");
          if (chosen) {
            setDate(
              chosen.publication_id === previous?.publicationId
                ? previous.date
                : todayInZone(chosen.timezone),
            );
            setGroup(
              chosen.publication_id === previous?.publicationId
                ? previous.group
                : "",
            );
          } else setBusy(false);
        })
        .catch((problem) => {
          if (!active) return;
          setBusy(false);
          setError(wb.error);
          if (problem instanceof ApiError && problem.status === 401)
            expired.current();
        });
    } else setBusy(false);
    return () => {
      active = false;
    };
  }, [workspace, canRead, canDraft, reload]);
  useEffect(() => {
    if (!source) return;
    let active = true;
    setBusy(true);
    setError("");
    setEvents([]);
    void collectWeek<ReaderEvent>(
      async (offset) => {
        const value = await publicationApi.get(source.publication_id, {
          start: date,
          end: date,
          view: "group",
          resource_id: group,
          offset,
        });
        if (active && offset === 0) setGroups(value.resources.group);
        return {
          events: value.events,
          total: value.total,
          offset: value.offset,
          limit: value.limit,
          key: `${value.publication_id}:${value.revision}`,
        };
      },
      `${source.publication_id}:${source.revision}`,
      () => active,
    )
      .then((loaded) => {
        if (active && loaded) setEvents(loaded);
      })
      .catch((problem) => {
        if (!active) return;
        setEvents([]);
        setGroups([]);
        setError(wb.error);
        if (problem instanceof ApiError && problem.status === 401)
          expired.current();
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [source, date, group]);
  const today = source
    ? todayInZone(source.timezone)
    : todayInZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const actions = [
    {
      view: "import" as const,
      label: wb.nav.import,
      permission: "import.source.read",
      icon: "file" as const,
    },
    {
      view: "calendar" as const,
      label: wb.nav.calendar,
      permission: "draft.read",
      icon: "clock" as const,
    },
    {
      view: "planning" as const,
      label: wb.nav.planning,
      permission: "draft.read",
      icon: "spark" as const,
    },
    {
      view: "versions" as const,
      label: wb.nav.versions,
      permission: "draft.read",
      icon: "layers" as const,
    },
  ].filter(
    (a) =>
      workspace.permissions.includes(a.permission) ||
      (a.view === "calendar" &&
        workspace.permissions.includes("calendar.manage")) ||
      (a.view === "planning" &&
        workspace.permissions.includes("catalog.manage")),
  );
  return (
    <section className="workbench-home" aria-labelledby="home-title">
      <div className="home-heading">
        <h1 id="home-title">{wb.overview}</h1>
        <p>{dayLabel(date, true)}</p>
        <span className="home-provenance">
          {workspace.scope.is_demo ? wb.demo : workspace.scope.name}
        </span>
      </div>
      <div
        className={`home-columns ${!canDraft && !actions.length ? "home-columns--reader" : ""}`}
      >
        <section
          className="home-agenda"
          aria-labelledby="agenda-title"
          aria-busy={busy}
        >
          <div className="agenda-heading">
            <h2 id="agenda-title">
              {date === today ? wb.todayLessons : wb.dayLessons}
            </h2>
            {!!groups.length && (
              <label>
                {wb.group}
                <select
                  aria-label="Күннің тобы"
                  value={group}
                  disabled={busy}
                  onChange={(e) => setGroup(e.target.value)}
                >
                  <option value="">{wb.all}</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {demoName(g.name, source?.data_kind ?? "college")}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {canRead && (
            <div className="agenda-context">
              <label>
                {wb.date}
                <input
                  type="date"
                  required
                  value={date}
                  disabled={busy}
                  onChange={(e) => {
                    if (e.target.value) setDate(e.target.value);
                  }}
                />
              </label>
              {publications.length > 1 && (
                <label>
                  {wb.source}
                  <select
                    value={publicationId}
                    disabled={busy}
                    onChange={(e) => {
                      setPublicationId(e.target.value);
                      setGroup("");
                      setGroups([]);
                    }}
                  >
                    {publications.map((p) => (
                      <option key={p.publication_id} value={p.publication_id}>
                        {p.academic_year} · {vm.number} {p.version_number}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {source && (
                <span>
                  {wb.published} · {vm.number} {source.version_number} ·{" "}
                  {source.academic_year} · {source.timezone}
                </span>
              )}
            </div>
          )}
          <div className="agenda-feedback" aria-live="polite">
            {busy && <p role="status">{wb.loading}</p>}
            {error && (
              <p role="alert" className="error-message">
                {error}{" "}
                <button
                  className="button button-quiet"
                  onClick={() => setReload((v) => v + 1)}
                >
                  {wb.retry}
                </button>
              </p>
            )}
            {!busy && !error && !source && canRead && (
              <p className="agenda-empty">{wb.noPublication}</p>
            )}
            {!busy && !error && source && !events.length && (
              <p className="agenda-empty">{wb.noLessons}</p>
            )}
          </div>
          {!busy && !error && (
            <ol className="agenda-list">
              {events.map((event) => (
                <li key={event.id}>
                  <span className="agenda-time">
                    {event.start}–{event.end}
                  </span>
                  <div
                    className={`agenda-lesson subject-tone-${subjectTone(event.subject)}`}
                  >
                    <strong>
                      {demoName(event.subject, source?.data_kind ?? "college")}
                    </strong>
                    <span>
                      {demoName(event.teacher, source?.data_kind ?? "college")}{" "}
                      · {demoName(event.room, source?.data_kind ?? "college")}
                    </span>
                    <span>
                      {demoName(event.group, source?.data_kind ?? "college")}
                    </span>
                  </div>
                </li>
              ))}
            </ol>
          )}
          {canRead && (
            <div className="agenda-actions">
              <button
                className="button button-primary"
                onClick={() =>
                  onOpenPublication(source?.publication_id, date, group)
                }
              >
                {wb.openWeek}
                <Icon name="arrow" size={18} />
              </button>
            </div>
          )}
          {!canRead && <p>{wb.permissionHint}</p>}
        </section>
        {(canDraft || !!actions.length) && (
          <div className="home-secondary">
            {canDraft && (
              <section className="home-draft">
                <h2>{wb.draft}</h2>
                {draftError && (
                  <p role="alert">
                    {draftError}{" "}
                    <button
                      className="button button-quiet"
                      onClick={() => setReload((v) => v + 1)}
                    >
                      {wb.retry}
                    </button>
                  </p>
                )}
                {draftBusy && <p role="status">{wb.loading}</p>}
                {draft ? (
                  <>
                    <div className="home-draft-title">
                      <h3>
                        {vm.number} {draft.version_number}
                      </h3>
                      <StatusBadge tone={statusTone("version", draft.status)}>
                        {versionStatuses[draft.status]}
                      </StatusBadge>
                    </div>
                    <p>{demoName(draft.name, draft.data_kind)}</p>
                    <dl>
                      <div>
                        <dt>{t.scopeLabel}</dt>
                        <dd>{workspace.scope.name}</dd>
                      </div>
                      <div>
                        <dt>{vm.revision}</dt>
                        <dd>{draft.revision}</dd>
                      </div>
                      <div>
                        <dt>{wb.academicYear}</dt>
                        <dd>{draft.academic_year}</dd>
                      </div>
                    </dl>
                    <button
                      className="button button-quiet"
                      onClick={() => onOpenDraft(draft.id)}
                    >
                      {wb.openDraft}
                    </button>
                  </>
                ) : (
                  !draftBusy && !draftError && <p>{wb.noDraft}</p>
                )}
              </section>
            )}
            {!!actions.length && (
              <section className="home-continue">
                <h2>{wb.continue}</h2>
                {actions.map((action) => (
                  <button
                    key={action.view}
                    onClick={() => onNavigate(action.view)}
                  >
                    <span className="home-action-icon">
                      <Icon name={action.icon} size={21} />
                    </span>
                    <span>{action.label}</span>
                    <Icon name="right" size={17} />
                  </button>
                ))}
              </section>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
