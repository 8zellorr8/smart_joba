import { useEffect, useRef, useState } from "react";
import { ApiError } from "./api";
import { demoName } from "./demo-labels";
import { tq } from "./locales/teacher-queue.kk";
import { formatDate, formatDateTime } from "./ui/dateTime";
import { teacherQueueApi } from "./teacher-queue-api";
import type {
  AttendanceCursor,
  PendingAttendance,
  PendingSubmission,
  QueuePage,
  SubmissionCursor,
} from "./teacher-queue-api";
import "./teacher-queue.css";

export function TeacherQueue({
  scope,
  onExpired,
  onOpenTask,
  onOpenLesson,
}: {
  scope: string;
  onExpired: () => void;
  onOpenTask: (course: string, task: string, submission: string) => void;
  onOpenLesson: (journal: string, lesson: string) => void;
}) {
  const [submissions, setSubmissions] = useState<QueuePage<
    PendingSubmission,
    SubmissionCursor
  > | null>(null);
  const [attendance, setAttendance] = useState<QueuePage<
    PendingAttendance,
    AttendanceCursor
  > | null>(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState<"submissions" | "attendance" | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const epoch = useRef(0);
  const expired = useRef(onExpired);
  expired.current = onExpired;

  function fail(e: unknown) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
      setSubmissions(null);
      setAttendance(null);
      if (e.status === 401) expired.current();
    }
    setError(tq.error);
  }

  useEffect(() => {
    const id = ++epoch.current;
    setLoading(true);
    setError("");
    setSubmissions(null);
    setAttendance(null);
    void Promise.all([
      teacherQueueApi.submissions(scope),
      teacherQueueApi.attendance(scope),
    ])
      .then(([tasks, lessons]) => {
        if (epoch.current === id) {
          setSubmissions(tasks);
          setAttendance(lessons);
        }
      })
      .catch((e) => {
        if (epoch.current === id) fail(e);
      })
      .finally(() => {
        if (epoch.current === id) setLoading(false);
      });
    return () => {
      ++epoch.current;
    };
  }, [scope, reload]);

  async function loadMore(kind: "submissions" | "attendance") {
    const id = epoch.current;
    setMore(kind);
    setError("");
    try {
      if (kind === "submissions" && submissions?.next) {
        const page = await teacherQueueApi.submissions(scope, submissions.next);
        if (epoch.current === id)
          setSubmissions({
            items: [...submissions.items, ...page.items],
            next: page.next,
          });
      } else if (kind === "attendance" && attendance?.next) {
        const page = await teacherQueueApi.attendance(scope, attendance.next);
        if (epoch.current === id)
          setAttendance({
            items: [...attendance.items, ...page.items],
            next: page.next,
          });
      }
    } catch (e) {
      if (epoch.current === id) fail(e);
    } finally {
      if (epoch.current === id) setMore(null);
    }
  }

  return (
    <section
      className="panel teacher-queue"
      aria-labelledby="teacher-queue-title"
    >
      <div className="teacher-queue-heading">
        <div>
          <h2 id="teacher-queue-title">{tq.title}</h2>
          <p>{tq.description}</p>
        </div>
        <button
          className="button button-quiet"
          disabled={loading}
          onClick={() => setReload((n) => n + 1)}
        >
          {tq.retry}
        </button>
      </div>
      {loading && <p role="status">{tq.loading}</p>}
      {error && <p role="alert">{error}</p>}
      {submissions && attendance && (
        <div className="teacher-queue-grid">
          <section aria-labelledby="teacher-submissions-title">
            <h3 id="teacher-submissions-title">{tq.submissions}</h3>
            {!submissions.items.length && <p>{tq.emptySubmissions}</p>}
            <ul>
              {submissions.items.map((item) => (
                <li key={item.id}>
                  <button
                    className="teacher-queue-item"
                    onClick={() =>
                      onOpenTask(item.course_id, item.task_id, item.id)
                    }
                  >
                    <strong>{item.title}</strong>
                    <span>
                      {demoName(item.subject, item.data_kind)} ·{" "}
                      {demoName(item.group, item.data_kind)}
                    </span>
                    <span>
                      {demoName(item.student_name, item.data_kind)} ·{" "}
                      {tq.attempt} {item.attempt}
                    </span>
                    <small>
                      {formatDateTime(item.submitted_at, item.timezone)}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
            {submissions.next && (
              <button
                className="button button-quiet"
                disabled={!!more}
                onClick={() => void loadMore("submissions")}
              >
                {tq.more}
              </button>
            )}
          </section>
          <section aria-labelledby="teacher-attendance-title">
            <h3 id="teacher-attendance-title">{tq.attendance}</h3>
            {!attendance.items.length && <p>{tq.emptyAttendance}</p>}
            <ul>
              {attendance.items.map((item) => (
                <li key={item.id}>
                  <button
                    className="teacher-queue-item"
                    onClick={() => onOpenLesson(item.journal_id, item.id)}
                  >
                    <strong>{demoName(item.subject, item.data_kind)}</strong>
                    <span>{demoName(item.group, item.data_kind)}</span>
                    <span>
                      {formatDate(item.date)} · {item.start}
                    </span>
                    <small>
                      {tq.missing}: {item.missing}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
            {attendance.next && (
              <button
                className="button button-quiet"
                disabled={!!more}
                onClick={() => void loadMore("attendance")}
              >
                {tq.more}
              </button>
            )}
          </section>
        </div>
      )}
    </section>
  );
}
