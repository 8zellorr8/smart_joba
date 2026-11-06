import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { ApiError } from "./api";
import { taskApi } from "./task-api";
import type {
  ReviewInput,
  Submission,
  TaskCreate,
  TaskDetails,
  TaskReview,
} from "./task-api";
import { tm } from "./locales/tasks.kk";
import "./tasks.css";

type Save = (operation: () => Promise<unknown>) => Promise<void>;
type FormProps = {
  busy: boolean;
  stale?: boolean;
  dirty: () => void;
  save: Save;
};
const day = (value: string) => value.split("-").reverse().join(".");
const time = (value: string, timezone: string) =>
  new Intl.DateTimeFormat("kk-KZ", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timezone,
  }).format(new Date(value));
const resultLabel = (review: TaskReview | null) =>
  review
    ? review.outcome === "graded"
      ? `${tm.graded}: ${review.grade}`
      : tm.returned
    : tm.submitted;

export function TaskCreateForm({
  busy,
  dirty,
  save,
  topic,
  timezone,
  onSave,
  cancel,
}: FormProps & {
  topic: string;
  timezone: string;
  onSave: (body: TaskCreate) => Promise<unknown>;
  cancel: () => void;
}) {
  const operation = useRef(crypto.randomUUID());
  const [error, setError] = useState("");
  return (
    <form
      className="course-form"
      onChange={() => {
        operation.current = crypto.randomUUID();
        dirty();
      }}
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        const title = String(data.get("title")).trim(),
          instructions = String(data.get("instructions")).trim();
        if (!title || !instructions) {
          setError(tm.required);
          return;
        }
        void save(() =>
          onSave({
            id: operation.current,
            topic_id: topic,
            title,
            instructions,
            due_on: String(data.get("due_on")) || null,
          }),
        );
      }}
    >
      <fieldset disabled={busy}>
        <legend>{tm.add}</legend>
        <label>
          {tm.title}
          <input name="title" required maxLength={160} autoFocus />
        </label>
        <label>
          {tm.instructions}
          <textarea name="instructions" required maxLength={20000} rows={5} />
        </label>
        <label>
          {tm.due}
          <input name="due_on" type="date" />
        </label>
        <p className="task-hint">
          {tm.dueHint} {timezone}
        </p>
        {error && <p role="alert">{error}</p>}
        <div className="course-actions">
          <button className="button button-primary" type="submit">
            {tm.save}
          </button>
          <button
            className="button button-quiet"
            type="button"
            onClick={cancel}
          >
            {tm.cancel}
          </button>
        </div>
      </fieldset>
    </form>
  );
}

function AnswerForm({
  busy,
  stale,
  dirty,
  save,
  attempt,
  onSubmit,
}: FormProps & {
  attempt: number;
  onSubmit: (data: FormData) => Promise<unknown>;
}) {
  const [kind, setKind] = useState("text"),
    [error, setError] = useState("");
  const operation = useRef(crypto.randomUUID());
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget),
      file = data.get("file");
    if (kind === "text" && !String(data.get("text") ?? "").trim()) {
      setError(tm.required);
      return;
    }
    if (
      kind === "pdf" &&
      (!(file instanceof File) || !file.size || file.size > 5 * 1024 * 1024)
    ) {
      setError(tm.fileError);
      return;
    }
    data.set("id", operation.current);
    data.set("expected_attempt", String(attempt));
    void save(() => onSubmit(data));
  }
  return (
    <form
      className="course-form"
      onSubmit={submit}
      onChange={() => {
        operation.current = crypto.randomUUID();
        setError("");
        dirty();
      }}
    >
      <fieldset disabled={busy || stale}>
        <legend>{tm.submit}</legend>
        <p>{tm.noAnswer}</p>
        <label>
          {tm.answerKind}
          <select
            aria-label={tm.answerKind}
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            <option value="text">Мәтін</option>
            <option value="pdf">PDF</option>
          </select>
        </label>
        {kind === "text" ? (
          <label>
            {tm.answer}
            <textarea name="text" rows={6} maxLength={20000} required />
          </label>
        ) : (
          <label>
            {tm.pdf}
            <input
              name="file"
              type="file"
              accept="application/pdf,.pdf"
              required
            />
          </label>
        )}
        {error && <p role="alert">{error}</p>}
        <button className="button button-primary" type="submit">
          {tm.submit}
        </button>
      </fieldset>
    </form>
  );
}

function ReviewForm({
  busy,
  stale,
  dirty,
  save,
  submission,
  onSave,
}: FormProps & {
  submission: Submission;
  onSave: (body: ReviewInput) => Promise<unknown>;
}) {
  const review = submission.review;
  const [outcome, setOutcome] = useState<"graded" | "returned">(
      review?.outcome ?? "graded",
    ),
    [error, setError] = useState("");
  const operation = useRef(crypto.randomUUID());
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget),
      raw = String(data.get("grade") ?? "");
    if (outcome === "graded" && (!/^\d{1,3}$/.test(raw) || Number(raw) > 100)) {
      setError(tm.gradeError);
      return;
    }
    const feedback = String(data.get("feedback") ?? "").trim(),
      reason = String(data.get("reason") ?? "").trim();
    if ((outcome === "returned" && !feedback) || (review && !reason)) {
      setError(tm.required);
      return;
    }
    void save(() =>
      onSave({
        id: operation.current,
        expected_revision: review?.revision ?? 0,
        outcome,
        grade: outcome === "graded" ? Number(raw) : null,
        feedback,
        reason,
      }),
    );
  }
  return (
    <form
      className="course-form"
      onSubmit={submit}
      onChange={() => {
        operation.current = crypto.randomUUID();
        dirty();
        setError("");
      }}
    >
      <fieldset disabled={busy || stale}>
        <legend>{tm.check}</legend>
        <p className="task-hint">{tm.separateGrade}</p>
        <label>
          {tm.outcome}
          <select
            aria-label={tm.outcome}
            value={outcome}
            onChange={(e) => setOutcome(e.target.value as typeof outcome)}
          >
            <option value="graded">{tm.graded}</option>
            <option value="returned">{tm.returned}</option>
          </select>
        </label>
        {outcome === "graded" && (
          <label>
            {tm.grade}
            <input
              name="grade"
              type="number"
              min={0}
              max={100}
              step={1}
              required
              defaultValue={review?.grade ?? ""}
            />
          </label>
        )}
        <label>
          {tm.feedback}
          <textarea
            name="feedback"
            aria-label={tm.feedback}
            rows={3}
            maxLength={4000}
            required={outcome === "returned"}
            defaultValue={review?.feedback ?? ""}
          />
        </label>
        {!!review && (
          <label>
            {tm.reason}
            <textarea name="reason" rows={2} maxLength={500} required />
          </label>
        )}
        {error && <p role="alert">{error}</p>}
        <button className="button button-primary" type="submit">
          {tm.save}
        </button>
      </fieldset>
    </form>
  );
}

export function CourseTaskPage({
  scope,
  course,
  task,
  csrfToken,
  onDenied,
  onBack,
  onDirtyChange,
}: {
  scope: string;
  course: string;
  task: string;
  csrfToken: string;
  onDenied: (e: ApiError) => void;
  onBack: () => void;
  onDirtyChange: (value: boolean) => void;
}) {
  const [data, setData] = useState<TaskDetails | null>(null),
    [rows, setRows] = useState<Submission[]>([]),
    [next, setNext] = useState<string | null>(null);
  const [selected, setSelected] = useState<Submission[] | null>(null),
    [busy, setBusy] = useState(true),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [stale, setStale] = useState(false);
  const active = useRef(false),
    dirty = useRef(false),
    denied = useRef(onDenied),
    dirtyHandler = useRef(onDirtyChange);
  denied.current = onDenied;
  dirtyHandler.current = onDirtyChange;
  function change(value: boolean) {
    dirty.current = value;
    dirtyHandler.current(value);
  }
  function fail(e: unknown) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
      setData(null);
      setRows([]);
      setSelected(null);
      change(false);
      setNotice("");
      denied.current(e);
      return;
    }
    if (e instanceof ApiError && e.status === 409) {
      setStale(true);
      setError(tm.stale);
    } else if (
      e instanceof ApiError &&
      (e.status === 413 || e.code === "COURSE_PDF_INVALID")
    )
      setError(tm.fileError);
    else setError(tm.error);
  }
  async function load() {
    const result = await taskApi.get(scope, course, task);
    const list = result.can_manage
      ? await taskApi.submissions(scope, course, task)
      : null;
    if (!active.current) return;
    setData(result);
    setRows(list?.items ?? []);
    setNext(list?.next ?? null);
    setSelected(null);
    setStale(false);
    change(false);
  }
  useEffect(() => {
    active.current = true;
    void load()
      .catch((e) => {
        if (active.current) fail(e);
      })
      .finally(() => {
        if (active.current) setBusy(false);
      });
    return () => {
      active.current = false;
      dirtyHandler.current(false);
    };
  }, [scope, course, task]);
  async function run(operation: () => Promise<unknown>, save = false) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
      if (active.current && save) {
        change(false);
        setSelected(null);
        setData(null);
        setNotice(tm.saved);
        await load();
      }
    } catch (e) {
      if (active.current) fail(e);
    } finally {
      if (active.current) setBusy(false);
    }
  }
  const latest = data?.can_manage ? selected?.[0] : data?.attempts[0];
  const attempts = data?.can_manage ? selected : data?.attempts;
  const canSubmit =
    data &&
    !data.can_manage &&
    (!latest || latest.review?.outcome === "returned");
  function download(id: string) {
    void run(async () => {
      const blob = await taskApi.pdf(scope, course, task, id);
      if (!active.current) return;
      const url = URL.createObjectURL(blob),
        link = document.createElement("a");
      link.href = url;
      link.download = "answer.pdf";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }
  return (
    <section className="task-page" aria-labelledby="task-title">
      <div className="course-actions">
        <button
          className="button button-quiet"
          disabled={busy}
          onClick={onBack}
        >
          {tm.back}
        </button>
        {!error && (
          <button
            className="button button-quiet"
            disabled={busy}
            onClick={() => {
              if (dirty.current && !window.confirm(tm.leave)) return;
              void run(async () => {
                setData(null);
                setRows([]);
                setSelected(null);
                change(false);
                await load();
              });
            }}
          >
            {tm.refresh}
          </button>
        )}
      </div>
      <h2 id="task-title">{data?.task.title ?? tm.open}</h2>
      {busy && <p role="status">{tm.loading}</p>}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <div role="alert" className="error-message">
          <span>{error}</span>{" "}
          <button
            className="button button-quiet"
            disabled={busy}
            onClick={() => {
              if (dirty.current && !window.confirm(tm.leave)) return;
              void run(async () => {
                setData(null);
                setRows([]);
                setSelected(null);
                change(false);
                await load();
              });
            }}
          >
            {tm.refresh}
          </button>
        </div>
      )}
      {data && (
        <>
          <div className="panel task-description">
            <p className="course-text">{data.task.instructions}</p>
            <p>
              {tm.due}:{" "}
              <strong>
                {data.task.due_on ? day(data.task.due_on) : tm.noDue}
              </strong>{" "}
              · {data.task.timezone}
            </p>
            {data.task.due_on && <p className="task-hint">{tm.dueHint}</p>}
          </div>
          {data.can_manage && (
            <section aria-label={tm.responses}>
              <h3>{tm.responses}</h3>
              {!rows.length && <p>{tm.empty}</p>}
              <div className="task-responses">
                {rows.map((row) => (
                  <button
                    className="panel task-response"
                    key={row.id}
                    disabled={busy}
                    onClick={() => {
                      if (dirty.current && !window.confirm(tm.leave)) return;
                      void run(async () => {
                        setSelected(null);
                        change(false);
                        const result = await taskApi.attempts(
                          scope,
                          course,
                          task,
                          row.id,
                        );
                        if (active.current) setSelected(result.attempts);
                      });
                    }}
                  >
                    <strong>{row.student_name}</strong>
                    <span>
                      {tm.attempt} {row.attempt} · {resultLabel(row.review)}
                    </span>
                    {row.late && <span className="task-late">{tm.late}</span>}
                  </button>
                ))}
              </div>
              {next && (
                <button
                  className="button button-quiet"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const result = await taskApi.submissions(
                        scope,
                        course,
                        task,
                        next,
                      );
                      if (active.current) {
                        setRows((old) => [...old, ...result.items]);
                        setNext(result.next);
                      }
                    })
                  }
                >
                  {tm.more}
                </button>
              )}
            </section>
          )}
          {canSubmit && (
            <>
              {latest && <p className="task-return">{tm.returnHint}</p>}
              <AnswerForm
                key={latest?.id ?? "first"}
                busy={busy}
                stale={stale}
                dirty={() => change(true)}
                save={(op) => run(op, true)}
                attempt={latest?.attempt ?? 0}
                onSubmit={(body) =>
                  taskApi.submit(scope, course, task, body, csrfToken)
                }
              />
            </>
          )}
          {!!attempts?.length && (
            <section aria-label={tm.history}>
              <h3>{tm.history}</h3>
              {attempts.map((item, index) => (
                <article className="panel task-attempt" key={item.id}>
                  <h4>
                    {data.can_manage ? item.student_name + " · " : ""}
                    {tm.attempt} {item.attempt}
                  </h4>
                  <p>
                    {time(item.submitted_at, data.task.timezone)}{" "}
                    {item.late && <span className="task-late">{tm.late}</span>}
                  </p>
                  <p className="task-state">{resultLabel(item.review)}</p>
                  {item.kind === "text" ? (
                    <p className="course-text">{item.text}</p>
                  ) : (
                    <button
                      className="button button-quiet"
                      disabled={busy}
                      onClick={() => download(item.id)}
                    >
                      {tm.download}
                    </button>
                  )}
                  {item.reviews?.map((r) => (
                    <div className="task-review" key={r.revision}>
                      <strong>{resultLabel(r)}</strong>
                      <p>{time(r.created_at, data.task.timezone)}</p>
                      {r.feedback && (
                        <p className="task-feedback">{r.feedback}</p>
                      )}
                      {r.reason && (
                        <p>
                          {tm.reason}: {r.reason}
                        </p>
                      )}
                    </div>
                  ))}
                  {data.can_manage && index === 0 && (
                    <ReviewForm
                      key={item.id + ":" + (item.review?.revision ?? 0)}
                      busy={busy}
                      stale={stale}
                      dirty={() => change(true)}
                      save={(op) => run(op, true)}
                      submission={item}
                      onSave={(body) =>
                        taskApi.review(
                          scope,
                          course,
                          task,
                          item.id,
                          body,
                          csrfToken,
                        )
                      }
                    />
                  )}
                </article>
              ))}
            </section>
          )}
        </>
      )}
    </section>
  );
}
