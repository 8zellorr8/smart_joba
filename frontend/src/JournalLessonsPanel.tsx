import { useEffect, useRef, useState } from "react";
import { ApiError } from "./api";
import type { Journal } from "./journal-api";
import { lessonApi } from "./lesson-api";
import type {
  Attendance,
  Lesson,
  LessonChange,
  LessonPage,
  LessonSummary,
} from "./lesson-api";
import { useLessonCommand } from "./journal/useLessonCommand";
import { demoName } from "./demo-labels";
import { jm } from "./locales/journal.kk";
import { lm } from "./locales/lesson.kk";
import "./lessons.css";

export function JournalLessonsPanel({
  scope,
  journal,
  csrfToken,
  onExpired,
  onDirtyChange,
  onClose,
}: {
  scope: string;
  journal: Journal;
  csrfToken: string;
  onExpired: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onClose: () => void;
}) {
  const [page, setPage] = useState<LessonPage | null>(null);
  const [selected, setSelected] = useState<LessonSummary | null>(null);
  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [topic, setTopic] = useState("");
  const [marks, setMarks] = useState<Record<string, Attendance>>({});
  const [reason, setReason] = useState("");
  const [conducted, setConducted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<LessonChange[] | null>(null);
  const [historyNext, setHistoryNext] = useState<number | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const epoch = useRef(0);
  const expired = useRef(onExpired);
  expired.current = onExpired;
  const dirtyHandler = useRef(onDirtyChange);
  dirtyHandler.current = onDirtyChange;
  const changeRef = useRef(false);
  function denied() {
    setLesson(null);
    setPage(null);
    setSelected(null);
    setHistory(null);
    setMarks({});
    setTopic("");
    setReason("");
    setError(jm.denied);
  }
  function fail(e: unknown) {
    if (e instanceof ApiError && e.status === 401) expired.current();
    if (e instanceof ApiError && e.status === 403) denied();
    else
      setError(
        e instanceof ApiError
          ? (lm.errors[e.code] ?? jm.loadError)
          : jm.loadError,
      );
  }
  function install(data: Lesson) {
    setLesson(data);
    setTopic(data.topic);
    setMarks(
      Object.fromEntries(
        data.students.map((s) => [s.student_id, s.attendance]),
      ),
    );
    setReason("");
    setConducted(false);
    setHistory(null);
    setHistoryError("");
  }
  const command = useLessonCommand({
    scope,
    csrfToken,
    onExpired,
    onDenied: denied,
    onSaved: async (receipt) => {
      if (!receipt.lesson_id) return;
      // A confirmed receipt is final even if this subsequent read fails.
      changeRef.current = false;
      dirtyHandler.current(false);
      try {
        install(await lessonApi.get(scope, receipt.lesson_id));
      } catch (e) {
        setLesson(null);
        fail(e);
        throw e;
      }
    },
  });
  const dirty =
    !!lesson &&
    (topic !== lesson.topic ||
      reason !== "" ||
      conducted ||
      lesson.students.some((s) => marks[s.student_id] !== s.attendance));
  useEffect(() => {
    changeRef.current = dirty || !!command.pending || command.busy;
    dirtyHandler.current(changeRef.current);
  }, [dirty, command.pending, command.busy]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (changeRef.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("beforeunload", warn);
      dirtyHandler.current(false);
    };
  }, []);
  async function loadList(offset = 0) {
    const id = ++epoch.current;
    setLoading(true);
    setError("");
    setLesson(null);
    setSelected(null);
    setHistory(null);
    setPage(null);
    try {
      const data = await lessonApi.list(scope, journal.id, offset);
      if (epoch.current === id) setPage(data);
    } catch (e) {
      if (epoch.current === id) fail(e);
    } finally {
      if (epoch.current === id) setLoading(false);
    }
  }
  useEffect(() => {
    void loadList();
    return () => {
      ++epoch.current;
    };
  }, [scope, journal.id]);
  function canLeave() {
    return !command.busy && (!changeRef.current || window.confirm(jm.leave));
  }
  async function open(row: LessonSummary, confirmed = false) {
    if (!confirmed && !canLeave()) return;
    const id = ++epoch.current;
    command.reset();
    setError("");
    setLoading(true);
    setLesson(null);
    setHistory(null);
    setSelected(row);
    try {
      const data = row.lesson_id
        ? await lessonApi.get(scope, row.lesson_id)
        : await lessonApi.preview(scope, journal.id, row);
      if (epoch.current === id) install(data);
    } catch (e) {
      if (epoch.current === id) fail(e);
    } finally {
      if (epoch.current === id) setLoading(false);
    }
  }
  function reload() {
    if (!canLeave()) return;
    command.reset();
    if (selected) void open(selected, true);
    else void loadList(page?.offset ?? 0);
  }
  async function showHistory(offset = 0) {
    if (!lesson?.id) return;
    const id = epoch.current;
    setHistoryBusy(true);
    setHistoryError("");
    try {
      const result = await lessonApi.history(scope, lesson.id, offset);
      if (epoch.current === id) {
        setHistory(result.items);
        setHistoryNext(result.next_offset);
      }
    } catch (e) {
      if (epoch.current === id) {
        if (e instanceof ApiError && (e.status === 401 || e.status === 403))
          fail(e);
        else setHistoryError(jm.loadError);
      }
    } finally {
      if (epoch.current === id) setHistoryBusy(false);
    }
  }
  function save() {
    if (!lesson) return;
    const attendance = lesson.students
      .filter((s) => s.active && marks[s.student_id] !== s.attendance)
      .map((s) => ({ student_id: s.student_id, value: marks[s.student_id] }));
    void command.perform({
      operation_id: crypto.randomUUID(),
      expected_revision: lesson.revision,
      expected_registry_revision: lesson.registry_revision,
      command: lesson.id
        ? {
            kind: "update_lesson",
            lesson_id: lesson.id,
            topic: topic === lesson.topic ? null : topic,
            attendance,
            reason,
          }
        : {
            kind: "record_lesson",
            journal_id: journal.id,
            publication_id: lesson.source.publication_id,
            event_id: lesson.source.event_id,
            topic,
            attendance,
            conducted,
            reason,
          },
    });
  }
  const locked =
    command.busy || command.stale || !!command.pending || !lesson?.can_write;
  const markLabel = (mark: Attendance) => lm.attendanceValues[mark ?? ""];
  return (
    <section className="journal-lessons">
      <div className="lesson-toolbar">
        <button
          className="button button-quiet"
          disabled={command.busy}
          onClick={() => {
            if (canLeave()) onClose();
          }}
        >
          {lm.close}
        </button>
        {selected && (
          <button
            className="button button-quiet"
            disabled={command.busy}
            onClick={() => {
              if (canLeave()) {
                command.reset();
                void loadList(page?.offset ?? 0);
              }
            }}
          >
            {lm.back}
          </button>
        )}
      </div>
      <h2>
        {demoName(journal.subject, journal.data_kind)} ·{" "}
        {demoName(journal.group, journal.data_kind)}
      </h2>
      <p className="journal-note">
        {journal.data_kind === "synthetic" ? jm.synthetic : jm.college} ·{" "}
        {journal.semester} {jm.semester}
      </p>
      {loading && <p role="status">{jm.loading}</p>}
      {error && (
        <div role="alert" className="journal-error">
          <p>{error}</p>
          <button className="button button-quiet" onClick={reload}>
            {jm.retry}
          </button>
        </div>
      )}
      {command.saved && (
        <p role="status" className="success-message">
          {lm.saved}
        </p>
      )}
      {command.error && (
        <div
          role="alert"
          tabIndex={-1}
          ref={command.errorRef}
          className="journal-error"
        >
          <p>{command.error}</p>
          {command.field && <a href={`#lesson-${command.field}`}>{jm.edit}</a>}
          {command.pending && (
            <button
              className="button button-primary"
              disabled={command.busy}
              onClick={() => void command.perform(command.pending!)}
            >
              {jm.retrySave}
            </button>
          )}
          {command.stale && (
            <button className="button button-quiet" onClick={reload}>
              {jm.retry}
            </button>
          )}
        </div>
      )}
      {!selected && page && (
        <div className="panel">
          <h3>{lm.title}</h3>
          {page.total === 0 ? (
            <p>{lm.empty}</p>
          ) : (
            <>
              <div
                className="table-scroll"
                role="region"
                aria-label={lm.title}
                tabIndex={0}
              >
                <table>
                  <thead>
                    <tr>
                      <th>{jm.date}</th>
                      <th>{lm.title}</th>
                      <th>{lm.openLesson}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.items.map((row) => (
                      <tr key={`${row.publication_id}-${row.event_id}`}>
                        <td>
                          {row.date}
                          <small className="lesson-time">
                            {row.start}–{row.end}
                          </small>
                        </td>
                        <td>
                          <span
                            className={`lesson-state ${row.recorded ? "is-recorded" : ""}`}
                          >
                            {row.recorded ? lm.recorded : lm.planned}
                          </span>
                          {row.needs_mapping && (
                            <p className="journal-note">
                              {lm.errors.JOURNAL_MAPPING_REQUIRED}
                            </p>
                          )}
                          {row.blocked && (
                            <p className="journal-note">
                              {lm.errors[row.blocked] ?? jm.denied}
                            </p>
                          )}
                        </td>
                        <td>
                          <button
                            className="button button-quiet"
                            onClick={() => void open(row)}
                          >
                            {lm.openLesson}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="lesson-toolbar">
                <button
                  className="button button-quiet"
                  disabled={page.offset === 0}
                  onClick={() =>
                    void loadList(Math.max(0, page.offset - page.limit))
                  }
                >
                  {lm.previous}
                </button>
                <span>
                  {page.offset + 1}–
                  {Math.min(page.offset + page.limit, page.total)} /{" "}
                  {page.total}
                </span>
                <button
                  className="button button-quiet"
                  disabled={page.offset + page.limit >= page.total}
                  onClick={() => void loadList(page.offset + page.limit)}
                >
                  {lm.next}
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {lesson && (
        <div className="panel lesson-card">
          <header className="lesson-card-heading">
            <div>
              <span
                className={`lesson-state ${lesson.recorded ? "is-recorded" : ""}`}
              >
                {lesson.recorded ? lm.recorded : lm.planned}
              </span>
              <h3>
                {lesson.source.date} · {lesson.source.start}–{lesson.source.end}
              </h3>
              <p>
                {lesson.source.timezone} ·{" "}
                {demoName(lesson.source.teacher, journal.data_kind)}
              </p>
            </div>
            <p className="journal-note">
              {lm.source}: {lm.version} {lesson.source.version_number} · r
              {lesson.source.publication_revision}
            </p>
          </header>
          {lesson.source_changed && (
            <p className="journal-note lesson-notice">{lm.changed}</p>
          )}
          {lesson.blocked && (
            <p className="journal-note lesson-notice">
              {lm.errors[lesson.blocked] ?? jm.loadError}
            </p>
          )}
          {!lesson.can_write && !lesson.blocked && (
            <p className="journal-note">{lm.readonly}</p>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <fieldset disabled={locked}>
              <label htmlFor="lesson-topic">{lm.topic}</label>
              <textarea
                id="lesson-topic"
                value={topic}
                maxLength={2000}
                required
                rows={3}
                onChange={(e) => setTopic(e.target.value)}
                aria-invalid={command.field === "topic" || undefined}
                aria-describedby="lesson-topic-help"
              />
              <p id="lesson-topic-help" className="journal-note">
                {command.field === "topic" ? command.error : lm.topicHelp}
              </p>
              <h4>{lesson.recorded ? lm.snapshot : lm.preview}</h4>
              <div
                className="table-scroll"
                role="region"
                aria-label={lm.attendance}
                tabIndex={0}
              >
                <table>
                  <thead>
                    <tr>
                      <th>{lm.student}</th>
                      <th>{lm.attendance}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lesson.students.map((s) => (
                      <tr key={s.student_id}>
                        <th scope="row">
                          {s.display_name}
                          {!s.active && (
                            <small className="lesson-time">{lm.removed}</small>
                          )}
                        </th>
                        <td>
                          {s.active && lesson.can_write ? (
                            <select
                              aria-label={`${lm.attendance}: ${s.display_name}`}
                              value={marks[s.student_id] ?? ""}
                              onChange={(e) =>
                                setMarks((old) => ({
                                  ...old,
                                  [s.student_id]: (e.target.value ||
                                    null) as Attendance,
                                }))
                              }
                            >
                              {Object.entries(lm.attendanceValues).map(
                                ([value, label]) => (
                                  <option key={value} value={value}>
                                    {label}
                                  </option>
                                ),
                              )}
                            </select>
                          ) : (
                            markLabel(s.attendance)
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!lesson.students.length && <p>{jm.noRoster}</p>}
              <p className="journal-note">
                {lm.partial}:{" "}
                {
                  lesson.students.filter(
                    (s) => s.active && marks[s.student_id] === null,
                  ).length
                }
              </p>
              {lesson.can_write && (
                <>
                  <label htmlFor="lesson-reason">{lm.reason}</label>
                  <input
                    id="lesson-reason"
                    value={reason}
                    maxLength={500}
                    onChange={(e) => setReason(e.target.value)}
                    aria-invalid={command.field === "reason" || undefined}
                    aria-describedby="lesson-reason-help"
                  />
                  <p id="lesson-reason-help" className="journal-note">
                    {command.field === "reason"
                      ? command.error
                      : lm.correctionHelp}
                  </p>
                  {!lesson.recorded && (
                    <>
                      <label
                        className="journal-check"
                        htmlFor="lesson-conducted"
                      >
                        <input
                          id="lesson-conducted"
                          type="checkbox"
                          checked={conducted}
                          required
                          onChange={(e) => setConducted(e.target.checked)}
                        />
                        {lm.conducted}
                      </label>
                      <p className="journal-note">{lm.confirmationHelp}</p>
                    </>
                  )}
                  <button
                    className="button button-primary"
                    type="submit"
                    disabled={!dirty || !lesson.students.some((s) => s.active)}
                  >
                    {command.busy ? jm.saving : jm.save}
                  </button>
                </>
              )}
            </fieldset>
          </form>
          {lesson.id && (
            <section className="lesson-history">
              <button
                className="button button-quiet"
                disabled={historyBusy}
                onClick={() => void showHistory()}
              >
                {historyBusy ? jm.loading : lm.history}
              </button>
              {historyError && <p role="alert">{historyError}</p>}
              {history && (
                <>
                  <h4>{lm.history}</h4>
                  {history.length === 0 && <p>{lm.noHistory}</p>}
                  {history.map((h) => (
                    <article key={h.id} className="lesson-history-row">
                      <strong>
                        {lm.actions[h.action] ?? h.action} · r{h.revision}
                      </strong>
                      <p>
                        {new Intl.DateTimeFormat("kk-KZ", {
                          year: "numeric",
                          month: "2-digit",
                          day: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                          hourCycle: "h23",
                          timeZone: lesson.source.timezone,
                        }).format(new Date(h.created_at))}{" "}
                        · {lm.actor}: {h.actor_name ?? h.actor_id}
                      </p>
                      {h.reason && (
                        <p>
                          {lm.reason}: {h.reason}
                        </p>
                      )}
                      {h.before.lesson?.topic !== h.after.lesson?.topic && (
                        <p>
                          {lm.topic}: {h.before.lesson?.topic || "—"} →{" "}
                          {h.after.lesson?.topic || "—"}
                        </p>
                      )}
                      {(h.after.students ?? [])
                        .filter(
                          (s) =>
                            (h.before.students?.find(
                              (b) => b.student_id === s.student_id,
                            )?.attendance ?? null) !== s.attendance,
                        )
                        .map((s) => (
                          <p key={s.student_id}>
                            {s.display_name}:{" "}
                            {markLabel(
                              h.before.students?.find(
                                (b) => b.student_id === s.student_id,
                              )?.attendance ?? null,
                            )}{" "}
                            → {markLabel(s.attendance)}
                          </p>
                        ))}
                      {h.action === "correct_roster" &&
                        (h.after.students ?? [])
                          .filter(
                            (s) =>
                              h.before.students?.find(
                                (b) => b.student_id === s.student_id,
                              )?.active !== s.active,
                          )
                          .map((s) => (
                            <p key={`roster-${s.student_id}`}>
                              {s.display_name}:{" "}
                              {s.active ? lm.rosterAdded : lm.removed}
                            </p>
                          ))}
                    </article>
                  ))}
                  {historyNext !== null && (
                    <button
                      className="button button-quiet"
                      disabled={historyBusy}
                      onClick={() => void showHistory(historyNext)}
                    >
                      {lm.next}
                    </button>
                  )}
                </>
              )}
            </section>
          )}
        </div>
      )}
    </section>
  );
}
