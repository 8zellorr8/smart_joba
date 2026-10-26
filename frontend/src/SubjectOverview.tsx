import { useEffect, useRef, useState } from "react";
import { ApiError } from "./api";
import type { Workspace } from "./api";
import { publicationApi } from "./publication-api";
import type { PublishedSummary } from "./publication-api";
import { loadPublishedSubjects } from "./portal/subjects";
import type { PublishedSubject } from "./portal/subjects";
import { Icon } from "./icons";
import { demoName } from "./demo-labels";
import { portal as p } from "./locales/portal.kk";
import { messages as t } from "./locales/kk";
import { dayLabel } from "./timetable/dates";
import { subjectTone } from "./timetable/WeekPanel";

export const subjectsLabel = (workspace: Workspace) =>
  workspace.permissions.includes("publication.read")
    ? p.subjects
    : p.mySubjects;
type OpenPublication = (id: string, date: string, group: string) => void;
const noSources: PublishedSummary[] = [];
const names = (subject: PublishedSubject, field: "group" | "teacher") => [
  ...new Set(
    subject.events.map((e) => demoName(e[field], subject.source.data_kind)),
  ),
];

export function SubjectOverview({
  workspace,
  sources,
  waiting = false,
  sourceError = "",
  onRetry,
  onExpired,
  onOpenPublication,
  preview = false,
  onAllSubjects,
  onOpenSubject,
  initialSubjectKey = "",
}: {
  workspace: Workspace;
  sources: PublishedSummary[];
  waiting?: boolean;
  sourceError?: string;
  onRetry: () => void;
  onExpired: () => void;
  onOpenPublication: OpenPublication;
  preview?: boolean;
  onAllSubjects?: () => void;
  onOpenSubject?: (key: string) => void;
  initialSubjectKey?: string;
}) {
  const canRead = workspace.permissions.some((permission) =>
    permission.startsWith("publication.read"),
  );
  const current = sources.filter((source) => source.is_current);
  const key = JSON.stringify([
    workspace.scope.id,
    workspace.permissions,
    current.map((source) => [source.publication_id, source.revision]),
  ]);
  const [result, setResult] = useState<{
    key: string;
    subjects: PublishedSubject[];
    error: string;
    busy: boolean;
  }>({ key: "", subjects: [], error: "", busy: true });
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState(initialSubjectKey);
  const expired = useRef(onExpired);
  expired.current = onExpired;
  const detailRef = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    let active = true;
    setResult({ key, subjects: [], error: "", busy: canRead });
    if (canRead)
      void loadPublishedSubjects(sources, () => active)
        .then((subjects) => {
          if (active && subjects)
            setResult({ key, subjects, error: "", busy: false });
        })
        .catch((problem) => {
          if (!active) return;
          setResult({ key, subjects: [], error: p.loadError, busy: false });
          if (problem instanceof ApiError && problem.status === 401)
            expired.current();
        });
    return () => {
      active = false;
    };
  }, [key, sources, canRead]);
  // Hide the previous scope/snapshot synchronously, before the next effect runs.
  const subjects =
    result.key === key && !waiting && !sourceError ? result.subjects : [];
  const busy = canRead && (waiting || result.key !== key || result.busy);
  const error = sourceError || (result.key === key ? result.error : "");
  const selected = subjects.find((subject) => subject.key === selectedKey);
  const visible = subjects.filter((subject) =>
    [
      demoName(subject.name, subject.source.data_kind),
      ...names(subject, "group"),
      ...names(subject, "teacher"),
    ]
      .join(" ")
      .toLocaleLowerCase("kk")
      .includes(query.trim().toLocaleLowerCase("kk")),
  );
  function openSubject(subject: PublishedSubject) {
    if (onOpenSubject) onOpenSubject(subject.key);
    else {
      setSelectedKey(subject.key);
      requestAnimationFrame(() => detailRef.current?.focus());
    }
  }
  return (
    <section
      className={`portal-subjects ${preview ? "portal-subjects--preview" : ""}`}
      aria-label={p.subjectOverview}
      aria-busy={busy}
    >
      {selected && !preview ? (
        <>
          <button
            className="button button-quiet subject-back"
            onClick={() => {
              setSelectedKey("");
              requestAnimationFrame(() => listRef.current?.focus());
            }}
          >
            <Icon name="left" size={18} />
            {p.backToSubjects}
          </button>
          <header className="subject-detail-heading">
            <span
              className={`subject-cover-icon subject-tone-${subjectTone(selected.name)}`}
            >
              <Icon name="book" size={30} />
            </span>
            <div>
              <p className="portal-kicker">
                {p.publication} · {selected.source.academic_year}
              </p>
              <h2 ref={detailRef} tabIndex={-1}>
                {demoName(selected.name, selected.source.data_kind)}
              </h2>
              <p>
                {names(selected, "group").join(" · ")} ·{" "}
                {names(selected, "teacher").join(", ")}
              </p>
            </div>
          </header>
          <p className="subject-source">
            {selected.source.data_kind === "synthetic" &&
              `${p.demonstration} · `}
            {p.scheduledLessons} · {selected.events.length} {p.lessonUnit} · №
            {selected.source.version_number}
          </p>
          <div
            className="table-wrap"
            tabIndex={0}
            role="region"
            aria-label={p.scheduledLessons}
          >
            <table>
              <thead>
                <tr>
                  <th>{p.date}</th>
                  <th>{p.group}</th>
                  <th>{p.teacher}</th>
                  <th>{p.room}</th>
                  <th>
                    <span className="sr-only">{p.openSchedule}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {selected.events.map((event) => (
                  <tr key={event.id}>
                    <td>
                      {dayLabel(event.date, true)}
                      <small className="subject-event-time">
                        {event.start}–{event.end}
                      </small>
                    </td>
                    <td>{demoName(event.group, selected.source.data_kind)}</td>
                    <td>
                      {demoName(event.teacher, selected.source.data_kind)}
                    </td>
                    <td>{demoName(event.room, selected.source.data_kind)}</td>
                    <td>
                      <button
                        className="button button-quiet"
                        aria-label={`${p.openSchedule}: ${dayLabel(event.date, true)}, ${event.start}`}
                        onClick={() =>
                          onOpenPublication(
                            selected.source.publication_id,
                            event.date,
                            "",
                          )
                        }
                      >
                        {p.openSchedule}
                        <Icon name="right" size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <>
          <div className="portal-section-heading">
            <div>
              <h2 ref={listRef} tabIndex={-1}>
                {p.subjectOverview}
              </h2>
              {preview && <p>{p.subjectDescription}</p>}
            </div>
            {preview && onAllSubjects && (
              <button className="button button-quiet" onClick={onAllSubjects}>
                {p.allSubjects}
                <Icon name="right" size={17} />
              </button>
            )}
          </div>
          {!preview && canRead && (
            <div className="subject-controls">
              <label>
                {p.search}
                <span className="subject-search">
                  <Icon name="search" size={20} />
                  <input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={p.searchPlaceholder}
                  />
                </span>
              </label>
              {query && (
                <button
                  className="button button-quiet"
                  onClick={() => setQuery("")}
                >
                  {p.clearSearch}
                </button>
              )}
              <span className="subject-count" role="status">
                {!busy && !error ? `${visible.length} ${p.subjectUnit}` : ""}
              </span>
            </div>
          )}
          <div className="subject-feedback" aria-live="polite">
            {!canRead ? (
              <p>{p.noAccess}</p>
            ) : error ? (
              <p role="alert" className="error-message">
                {error}
                <button className="button button-quiet" onClick={onRetry}>
                  {t.retry}
                </button>
              </p>
            ) : busy ? (
              <p role="status">{p.loading}</p>
            ) : !current.length ? (
              <p>{p.noPublication}</p>
            ) : !subjects.length ? (
              <p>{p.noSubjects}</p>
            ) : !visible.length ? (
              <p>{p.noMatches}</p>
            ) : selectedKey && !preview && !selected ? (
              <p>{p.changed}</p>
            ) : null}
          </div>
          {!busy && !error && canRead && (
            <div className="subject-grid">
              {(preview ? visible.slice(0, 6) : visible).map((subject) => (
                <article className="subject-card" key={subject.key}>
                  <a
                    href="#main"
                    className="subject-card-link"
                    onClick={(event) => {
                      event.preventDefault();
                      openSubject(subject);
                    }}
                    aria-label={`${p.openSubject}: ${demoName(subject.name, subject.source.data_kind)}`}
                  >
                    <span
                      className={`subject-cover subject-tone-${subjectTone(subject.name)}`}
                    >
                      <span>{subject.source.academic_year}</span>
                      <Icon name="book" size={52} />
                    </span>
                    <div className="subject-card-body">
                      <span className="subject-category">
                        {subject.source.data_kind === "synthetic"
                          ? p.demonstration
                          : p.publication}
                      </span>
                      <h3>
                        {demoName(subject.name, subject.source.data_kind)}
                      </h3>
                      <span className="subject-card-teachers">
                        {names(subject, "teacher").join(", ")}
                      </span>
                      <span className="subject-card-footer">
                        <span>{names(subject, "group").join(" · ")}</span>
                        <span>
                          {subject.events.length} {p.lessonUnit}
                        </span>
                      </span>
                    </div>
                  </a>
                </article>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

export function SubjectsPage({
  workspace,
  onExpired,
  onOpenPublication,
  initialSubjectKey,
}: {
  workspace: Workspace;
  onExpired: () => void;
  onOpenPublication: OpenPublication;
  initialSubjectKey?: string;
}) {
  const sourceKey = JSON.stringify([workspace.scope.id, workspace.permissions]);
  const [sourceOwner, setSourceOwner] = useState(sourceKey);
  const [sources, setSources] = useState<PublishedSummary[]>([]);
  const [waiting, setWaiting] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const canRead = workspace.permissions.some((permission) =>
    permission.startsWith("publication.read"),
  );
  const expired = useRef(onExpired);
  expired.current = onExpired;
  useEffect(() => {
    let active = true;
    setSourceOwner(sourceKey);
    setSources([]);
    setError("");
    setWaiting(canRead);
    if (canRead)
      void publicationApi
        .list(workspace.scope.id)
        .then((items) => {
          if (active) setSources(items.filter((source) => source.is_current));
        })
        .catch((problem) => {
          if (!active) return;
          setError(p.loadError);
          if (problem instanceof ApiError && problem.status === 401)
            expired.current();
        })
        .finally(() => {
          if (active) setWaiting(false);
        });
    return () => {
      active = false;
    };
  }, [sourceKey, workspace.scope.id, canRead, reload]);
  return (
    <section className="portal-subjects-page">
      <header className="portal-page-heading">
        <p className="portal-kicker">{p.title}</p>
        <h1>{subjectsLabel(workspace)}</h1>
        <p>{p.subjectDescription}</p>
      </header>
      <SubjectOverview
        key={sourceKey}
        workspace={workspace}
        sources={sourceOwner === sourceKey ? sources : noSources}
        waiting={sourceOwner !== sourceKey || waiting}
        sourceError={sourceOwner === sourceKey ? error : ""}
        onRetry={() => setReload((value) => value + 1)}
        onExpired={onExpired}
        onOpenPublication={onOpenPublication}
        initialSubjectKey={initialSubjectKey}
      />
    </section>
  );
}
