import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { ApiError } from "./api";
import { courseApi } from "./course-api";
import type { Course, CourseContents } from "./course-api";
import { demoName } from "./demo-labels";
import { Icon } from "./icons";
import { PageHeading } from "./ui/PageHeading";
import { CourseTaskPage, TaskCreateForm } from "./CourseTaskPage";
import { taskApi } from "./task-api";
import { tm } from "./locales/tasks.kk";
import "./courses.css";

type Save = (operation: () => Promise<unknown>) => Promise<void>;
function CourseForm({
  material,
  busy,
  save,
  onSave,
  cancel,
  onDirty,
}: {
  material: boolean;
  busy: boolean;
  save: Save;
  onSave: (id: string, title: string, form: FormData) => Promise<void>;
  cancel: () => void;
  onDirty: () => void;
}) {
  const [kind, setKind] = useState("text");
  const [error, setError] = useState("");
  const operation = useRef(crypto.randomUUID());
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const title = String(form.get("title") ?? "").trim();
    const file = form.get("file");
    if (
      !title ||
      (material && kind === "text" && !String(form.get("text") ?? "").trim())
    ) {
      setError("Міндетті өрістерді толтырыңыз.");
      return;
    }
    if (
      kind === "pdf" &&
      (!(file instanceof File) || !file.size || file.size > 5 * 1024 * 1024)
    ) {
      setError("Көлемі 5 МБ-тан аспайтын PDF файлын таңдаңыз.");
      return;
    }
    form.set("title", title);
    form.set("id", operation.current);
    await save(() => onSave(operation.current, title, form));
  }
  return (
    <form
      className="course-form"
      onSubmit={submit}
      onChange={() => {
        operation.current = crypto.randomUUID();
        setError("");
        onDirty();
      }}
    >
      <fieldset disabled={busy}>
        <legend>{material ? "Жаңа материал" : "Жаңа тақырып"}</legend>
        <label>
          {material ? "Материал атауы" : "Тақырып атауы"}
          <input autoFocus required name="title" maxLength={160} />
        </label>
        {material && (
          <>
            <label>
              Материал түрі
              <select
                aria-label="Материал түрі"
                value={kind}
                onChange={(e) => setKind(e.target.value)}
              >
                <option value="text">Мәтін</option>
                <option value="pdf">PDF құжаты</option>
              </select>
            </label>
            {kind === "text" ? (
              <label>
                Оқу мәтіні
                <textarea required name="text" rows={5} maxLength={20000} />
              </label>
            ) : (
              <label>
                PDF файлы · 5 МБ дейін
                <input
                  required
                  type="file"
                  name="file"
                  accept="application/pdf,.pdf"
                />
              </label>
            )}
          </>
        )}
        {error && (
          <p role="alert" className="error-message">
            {error}
          </p>
        )}
        <div className="course-actions">
          <button className="button button-primary" type="submit">
            Сақтау
          </button>
          <button
            className="button button-quiet"
            type="button"
            onClick={cancel}
          >
            Бас тарту
          </button>
        </div>
      </fieldset>
    </form>
  );
}

type Props = {
  scope: string;
  csrfToken: string;
  onExpired: () => void;
  onDirtyChange?: (dirty: boolean) => void;
};

export function CoursesPage(props: Props) {
  return <CourseWorkspace key={props.scope} {...props} />;
}

function CourseWorkspace({
  scope,
  csrfToken,
  onExpired,
  onDirtyChange,
}: Props) {
  const [courses, setCourses] = useState<Course[]>([]);
  const [search, setSearch] = useState("");
  const [detail, setDetail] = useState<CourseContents | null>(null);
  const [reading, setReading] = useState<{ id: string; text: string } | null>(
    null,
  );
  const [form, setForm] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  const [activeTask, setActiveTask] = useState<string | null>(null);
  const [unsaved, setUnsaved] = useState(false);
  const dirty = useRef(false);
  const dirtyHandler = useRef(onDirtyChange);
  dirty.current = unsaved;
  dirtyHandler.current = onDirtyChange;
  useEffect(() => {
    onDirtyChange?.(unsaved);
  }, [unsaved, onDirtyChange]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("beforeunload", warn);
      dirtyHandler.current?.(false);
    };
  }, []);
  function discard() {
    return !dirty.current || window.confirm(tm.leave);
  }
  function cancelForm() {
    if (discard()) {
      setForm(null);
      setUnsaved(false);
    }
  }
  const mounted = useRef(false);
  const expired = useRef(onExpired);
  expired.current = onExpired;

  function failed(e: unknown) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
      setCourses([]);
      setDetail(null);
      setReading(null);
      setForm(null);
      setActiveTask(null);
      setUnsaved(false);
      setNotice("");
      setError("Курсты көруге рұқсат жоқ.");
      if (e.status === 401) expired.current();
    } else if (e instanceof ApiError && e.code === "COURSE_PDF_INVALID") {
      setError("Файлды PDF пішімінде сақтап, қайта таңдаңыз.");
    } else if (e instanceof ApiError && e.status === 413) {
      setError("Файл көлемі 5 МБ-тан аспауы керек.");
    } else {
      setError("Әрекет орындалмады. Қайталап көріңіз.");
    }
  }
  useEffect(() => {
    let active = true;
    mounted.current = true;
    setBusy(true);
    setError("");
    setCourses([]);
    courseApi
      .list(scope)
      .then((data) => {
        if (active) setCourses(data);
      })
      .catch((e) => {
        if (active) failed(e);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
      mounted.current = false;
    };
  }, [scope, reload]);
  async function run(operation: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
    } catch (e) {
      if (mounted.current) failed(e);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function loadCourse(course: string) {
    const data = await courseApi.contents(scope, course);
    if (mounted.current) {
      setDetail(data);
      setForm(null);
      setReading(null);
      setActiveTask(null);
      setUnsaved(false);
    }
  }
  async function saved(course: string) {
    if (!mounted.current) return;
    setForm(null);
    setUnsaved(false);
    setNotice("Сақталды.");
    try {
      await loadCourse(course);
    } catch (e) {
      if (!mounted.current) return;
      if (e instanceof ApiError && (e.status === 401 || e.status === 403))
        throw e;
      setError("Сақталды, бірақ тізім жаңартылмады. Қайта жүктеңіз.");
    }
  }
  function back() {
    if (!discard()) return;
    setActiveTask(null);
    setUnsaved(false);
    setDetail(null);
    setCourses([]);
    setError("");
    setNotice("");
    setForm(null);
    setReading(null);
    setReload((r) => r + 1);
  }
  const query = search.trim().toLocaleLowerCase("kk");
  const visibleCourses = courses.filter((c) =>
    [
      demoName(c.subject, c.data_kind),
      demoName(c.group, c.data_kind),
      c.academic_year,
    ].some((value) => value.toLocaleLowerCase("kk").includes(query)),
  );
  return (
    <section className="course-page" aria-labelledby="courses-title">
      {detail && (
        <button
          className="button button-quiet course-back"
          disabled={busy}
          onClick={back}
        >
          <Icon name="left" size={17} />
          Курстарға оралу
        </button>
      )}
      <PageHeading
        id="courses-title"
        eyebrow="Оқу материалдары"
        title={
          detail
            ? demoName(detail.course.subject, detail.course.data_kind)
            : "Менің курстарым"
        }
        description={
          detail
            ? `${demoName(detail.course.group, detail.course.data_kind)} · ${detail.course.academic_year} · ${detail.course.semester}-семестр`
            : "Пән курсын ашып, тақырыптар мен оқу материалдарын қараңыз."
        }
      />
      {error && (
        <div role="alert" className="error-message">
          {error}{" "}
          <button
            className="button button-quiet"
            disabled={busy}
            onClick={() =>
              detail ? void run(() => loadCourse(detail.course.id)) : back()
            }
          >
            Қайта жүктеу
          </button>
        </div>
      )}
      {busy && <p role="status">Жүктелуде…</p>}
      {notice && <p role="status">{notice}</p>}
      {detail && activeTask ? (
        <CourseTaskPage
          key={activeTask}
          scope={scope}
          course={detail.course.id}
          task={activeTask}
          csrfToken={csrfToken}
          onDenied={failed}
          onDirtyChange={setUnsaved}
          onBack={() => {
            if (discard()) {
              setActiveTask(null);
              setUnsaved(false);
            }
          }}
        />
      ) : !detail ? (
        <>
          {!!courses.length && (
            <div className="course-filters">
              <label>
                Курстарды іздеу
                <span className="subject-search">
                  <Icon name="search" size={20} />
                  <input
                    type="search"
                    value={search}
                    placeholder="Пән немесе топ атауы"
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </span>
              </label>
              <span className="course-count" role="status">
                {visibleCourses.length} / {courses.length} курс
              </span>
              {!!search && (
                <button
                  className="button button-quiet"
                  onClick={() => setSearch("")}
                >
                  Іздеуді тазалау
                </button>
              )}
            </div>
          )}
          <div className="course-list">
            {!courses.length && !busy && !error && (
              <p className="panel">Сізге қолжетімді курстар әзірге жоқ.</p>
            )}
            {!!courses.length && !visibleCourses.length && (
              <p className="panel" role="status">
                Іздеу бойынша курс табылмады.
              </p>
            )}
            {visibleCourses.map((c) => (
              <article key={c.id} className="panel course-card">
                <div className="course-card-cover">
                  <span className="course-mark">
                    <Icon name="book" size={25} />
                  </span>
                  <span className="course-semester">{c.semester}-семестр</span>
                </div>
                <div className="course-card-body">
                  <h2>{demoName(c.subject, c.data_kind)}</h2>
                  <p>
                    {demoName(c.group, c.data_kind)} · {c.academic_year}
                  </p>
                  <button
                    className="button button-primary"
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        if (!c.opened)
                          await courseApi.open(scope, c.id, csrfToken);
                        await loadCourse(c.id);
                      })
                    }
                  >
                    {c.opened ? "Курсқа кіру" : "Курс құру"}
                    <Icon name="right" size={16} />
                  </button>
                </div>
              </article>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="course-toolbar">
            <h2>Курс тақырыптары</h2>
            {detail.course.can_manage && !form && (
              <button
                className="button button-primary"
                disabled={busy}
                onClick={() => setForm("topic")}
              >
                Тақырып қосу
              </button>
            )}
          </div>
          {form === "topic" && (
            <CourseForm
              key="topic"
              material={false}
              busy={busy}
              save={run}
              cancel={cancelForm}
              onDirty={() => setUnsaved(true)}
              onSave={async (id, title) => {
                await courseApi.addTopic(
                  scope,
                  detail.course.id,
                  id,
                  title,
                  csrfToken,
                );
                await saved(detail.course.id);
              }}
            />
          )}
          {!detail.topics.length && (
            <p className="panel">Курста әзірге тақырыптар жоқ.</p>
          )}
          {detail.topics.map((topic, index) => (
            <article className="panel course-topic" key={topic.id}>
              <div className="course-toolbar">
                <h3>
                  <span className="topic-number" aria-hidden="true">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  {topic.title}
                </h3>
                {detail.course.can_manage && !form && (
                  <div className="course-actions">
                    <button
                      className="button button-quiet"
                      disabled={busy}
                      onClick={() => setForm(topic.id)}
                    >
                      Материал қосу
                    </button>
                    <button
                      className="button button-quiet"
                      disabled={busy}
                      onClick={() => setForm("task:" + topic.id)}
                    >
                      {tm.add}
                    </button>
                  </div>
                )}
              </div>
              {!topic.materials.length && (
                <p>Бұл тақырыпқа материал әлі қосылған жоқ.</p>
              )}
              {topic.tasks?.map((task) => (
                <button
                  className="button button-quiet course-task-link"
                  aria-label={`${task.title} · ${tm.open}`}
                  key={task.id}
                  disabled={busy}
                  onClick={() => {
                    if (discard()) {
                      setForm(null);
                      setUnsaved(false);
                      setNotice("");
                      setError("");
                      setActiveTask(task.id);
                    }
                  }}
                >
                  <Icon name="edit" size={21} />
                  <span>
                    {task.title}
                    <small>{tm.open}</small>
                  </span>
                  <Icon name="right" size={18} />
                </button>
              ))}
              {form === "task:" + topic.id && (
                <TaskCreateForm
                  topic={topic.id}
                  timezone={detail.course.timezone ?? ""}
                  busy={busy}
                  dirty={() => setUnsaved(true)}
                  save={run}
                  cancel={cancelForm}
                  onSave={async (body) => {
                    await taskApi.create(
                      scope,
                      detail.course.id,
                      body,
                      csrfToken,
                    );
                    await saved(detail.course.id);
                  }}
                />
              )}
              {topic.materials.map((m) => (
                <div className="course-item" key={m.id}>
                  {m.kind === "pdf" ? (
                    <button
                      className="course-resource"
                      aria-label={`${m.title} · PDF жүктеу`}
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const blob = await courseApi.download(
                            scope,
                            detail.course.id,
                            m.id,
                          );
                          if (!mounted.current) return;
                          const url = URL.createObjectURL(blob);
                          const link = document.createElement("a");
                          link.href = url;
                          link.download =
                            m.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_") +
                            ".pdf";
                          link.click();
                          setTimeout(() => URL.revokeObjectURL(url), 1000);
                        })
                      }
                    >
                      <Icon name="download" size={20} />
                      <span>{m.title}</span>
                      <small>PDF жүктеу</small>
                    </button>
                  ) : (
                    <button
                      className="course-resource"
                      aria-label={`${m.title} · Мәтін`}
                      aria-expanded={reading?.id === m.id}
                      disabled={busy}
                      onClick={() => {
                        if (reading?.id === m.id) {
                          setReading(null);
                          return;
                        }
                        setReading(null);
                        void run(async () => {
                          const item = await courseApi.read(
                            scope,
                            detail.course.id,
                            m.id,
                          );
                          if (mounted.current)
                            setReading({ id: m.id, text: item.text });
                        });
                      }}
                    >
                      <Icon name="file" size={20} />
                      <span>{m.title}</span>
                      <small>Мәтін</small>
                    </button>
                  )}
                  {reading?.id === m.id && (
                    <div className="course-text">{reading.text}</div>
                  )}
                </div>
              ))}
              {form === topic.id && (
                <CourseForm
                  key={topic.id}
                  material
                  busy={busy}
                  save={run}
                  cancel={cancelForm}
                  onDirty={() => setUnsaved(true)}
                  onSave={async (_id, _title, data) => {
                    await courseApi.addMaterial(
                      scope,
                      detail.course.id,
                      topic.id,
                      data,
                      csrfToken,
                    );
                    await saved(detail.course.id);
                  }}
                />
              )}
            </article>
          ))}
        </>
      )}
    </section>
  );
}
