import { useEffect, useRef, useState } from "react";
import { ApiError } from "./api";
import { journalApi } from "./journal-api";
import type { ResultQuery, StudentResults } from "./journal-api";
import { demoName } from "./demo-labels";
import { jm } from "./locales/journal.kk";
import { lm } from "./locales/lesson.kk";
import { sm } from "./locales/student.kk";
import { PageHeading } from "./ui/PageHeading";
import { dayLabel } from "./timetable/dates";
import "./journal.css";
import "./student-results.css";

export function StudentResultsPage({
  scope,
  onExpired,
  onSchedule,
}: {
  scope: string;
  onExpired: () => void;
  onSchedule?: () => void;
}) {
  // Remount the stateful reader when the authorized scope changes.
  return (
    <Results
      key={scope}
      scope={scope}
      onExpired={onExpired}
      onSchedule={onSchedule}
    />
  );
}

function Results({
  scope,
  onExpired,
  onSchedule,
}: {
  scope: string;
  onExpired: () => void;
  onSchedule?: () => void;
}) {
  const [data, setData] = useState<StudentResults | null>(null);
  const [catalog, setCatalog] = useState<Omit<StudentResults, "items"> | null>(
    null,
  );
  const [query, setQuery] = useState<ResultQuery>({});
  const [visit, setVisit] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const epoch = useRef(0);
  const expired = useRef(onExpired);
  expired.current = onExpired;
  const heading = useRef<HTMLHeadingElement>(null);
  const shouldFocus = useRef(false);
  function navigate(next: ResultQuery, focus = false) {
    ++epoch.current;
    shouldFocus.current = focus;
    setData(null);
    setError("");
    setBusy(true);
    setQuery(next);
  }
  useEffect(() => {
    const id = ++epoch.current;
    setBusy(true);
    setData(null);
    setError("");
    void journalApi
      .results(scope, query)
      .then((result) => {
        if (id !== epoch.current) return;
        const { items: _items, ...meta } = result;
        setCatalog(meta);
        setData(result);
      })
      .catch((e: unknown) => {
        if (id !== epoch.current) return;
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
          setCatalog(null);
          setError(jm.denied);
          if (e.status === 401) expired.current();
        } else {
          setError(
            e instanceof ApiError && e.code === "JOURNAL_RESULTS_STALE"
              ? sm.stale
              : jm.loadError,
          );
        }
      })
      .finally(() => {
        if (id === epoch.current) setBusy(false);
      });
    return () => {
      ++epoch.current;
    };
  }, [scope, query, visit]);
  useEffect(() => {
    if (data && shouldFocus.current) {
      shouldFocus.current = false;
      heading.current?.focus();
    }
  }, [data]);
  const filters = {
    context_id: query.context_id,
    semester: query.semester,
    subject_id: query.subject_id,
  };
  function refresh() {
    navigate(catalog ? filters : {});
    setVisit((v) => v + 1);
  }
  return (
    <div className="journal-page student-results">
      <PageHeading
        id="student-results-title"
        eyebrow={jm.profile}
        title={sm.title}
        description={sm.description}
      />
      <div className="student-results-actions">
        {onSchedule && (
          <button className="button button-quiet" onClick={onSchedule}>
            {sm.schedule}
          </button>
        )}
        <button
          className="button button-quiet"
          onClick={refresh}
          disabled={busy}
        >
          {sm.refresh}
        </button>
      </div>
      {catalog && (
        <>
          <p className="student-results-identity">
            <strong>{catalog.student.display_name}</strong> ·{" "}
            {catalog.student.data_kind === "synthetic"
              ? jm.synthetic
              : jm.college}
          </p>
          <section
            className="panel student-results-filters"
            aria-label={sm.results}
          >
            <div className="student-result-filter">
              <label htmlFor="student-results-period">{sm.period}</label>
              <select
                id="student-results-period"
                value={
                  query.context_id
                    ? `${query.context_id}:${query.semester}`
                    : ""
                }
                onChange={(e) => {
                  const [context, semester] = e.target.value.split(":");
                  navigate({
                    subject_id: query.subject_id,
                    context_id: context || undefined,
                    semester: context ? Number(semester) : undefined,
                  });
                }}
              >
                <option value="">{sm.allPeriods}</option>
                {catalog.periods.map((p) => (
                  <option
                    key={`${p.context_id}:${p.semester}`}
                    value={`${p.context_id}:${p.semester}`}
                  >
                    {p.academic_year} · {p.semester} {jm.semester}
                  </option>
                ))}
              </select>
            </div>
            <div className="student-result-filter">
              <label htmlFor="student-results-subject">{sm.subject}</label>
              <select
                id="student-results-subject"
                value={query.subject_id ?? ""}
                onChange={(e) =>
                  navigate({
                    ...filters,
                    subject_id: e.target.value || undefined,
                  })
                }
              >
                <option value="">{sm.allSubjects}</option>
                {catalog.subjects.map((s) => (
                  <option key={s.id} value={s.id}>
                    {demoName(s.name, catalog.student.data_kind)}
                  </option>
                ))}
              </select>
            </div>
          </section>
        </>
      )}
      {busy && <p role="status">{jm.loading}</p>}
      {error && (
        <div role="alert" className="journal-error">
          <p>{error}</p>
          <button
            className="button button-quiet"
            onClick={
              error === sm.stale || error === jm.denied
                ? refresh
                : () => setVisit((v) => v + 1)
            }
          >
            {error === sm.stale ? sm.reload : jm.retry}
          </button>
        </div>
      )}
      {data && (
        <section aria-labelledby="student-results-list-title">
          <h2 id="student-results-list-title" tabIndex={-1} ref={heading}>
            {sm.results} · {sm.page} {data.page}
          </h2>
          <p className="journal-note">{sm.gradeHelp}</p>
          {!data.items.length ? (
            <p className="panel" role="status">
              {sm.empty}
            </p>
          ) : (
            <ol className="student-results-list">
              {data.items.map((item) => (
                <li className="panel student-result" key={item.id}>
                  <div className="student-result-main">
                    <p className="student-result-date">
                      <time dateTime={item.date}>
                        {dayLabel(item.date)} {item.date.slice(0, 4)}
                      </time>{" "}
                      · {item.start}–{item.end} · {item.timezone}
                    </p>
                    <h3>{demoName(item.subject, data.student.data_kind)}</h3>
                    <p>
                      {demoName(item.group, data.student.data_kind)} ·{" "}
                      {item.academic_year} · {item.semester} {jm.semester}
                    </p>
                    <p className="student-result-topic">
                      <strong>{sm.topic}</strong>
                      <br />
                      {item.topic}
                    </p>
                    {!item.active && (
                      <p className="journal-note">{sm.removed}</p>
                    )}
                  </div>
                  <dl className="student-result-values">
                    <div>
                      <dt>{sm.grade}</dt>
                      <dd
                        className={
                          item.grade === null
                            ? "student-result-empty"
                            : "student-result-grade"
                        }
                      >
                        {item.grade === null ? sm.noGrade : item.grade}
                      </dd>
                    </div>
                    <div>
                      <dt>{sm.attendance}</dt>
                      <dd>{lm.attendanceValues[item.attendance ?? ""]}</dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ol>
          )}
          <nav className="student-results-pagination" aria-label={sm.results}>
            <button
              className="button button-quiet"
              disabled={data.page <= 1}
              onClick={() =>
                navigate(
                  { ...filters, page: data.page - 1, revision: data.revision },
                  true,
                )
              }
            >
              {sm.previous}
            </button>
            <span>
              {sm.page} {data.page}
            </span>
            <button
              className="button button-quiet"
              disabled={!data.has_next}
              onClick={() =>
                navigate(
                  { ...filters, page: data.page + 1, revision: data.revision },
                  true,
                )
              }
            >
              {sm.next}
            </button>
          </nav>
        </section>
      )}
      {catalog && (
        <details className="panel student-profile-details">
          <summary>{sm.profile}</summary>
          <h2>{catalog.student.display_name}</h2>
          <h3>{jm.memberships}</h3>
          {catalog.memberships.length ? (
            <div className="journal-catalog">
              {catalog.memberships.map((m) => (
                <article key={m.id}>
                  <strong>
                    {demoName(m.group, catalog.student.data_kind)}
                  </strong>
                  <p>{m.academic_year}</p>
                  <p>
                    {m.start} — {m.end}
                  </p>
                </article>
              ))}
            </div>
          ) : (
            <p>{jm.noMemberships}</p>
          )}
          <p className="journal-note">{jm.intervalHelp}</p>
        </details>
      )}
    </div>
  );
}
