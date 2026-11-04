import { useEffect, useRef, useState } from "react";
import { ApiError } from "./api";
import type { Journal } from "./journal-api";
import { lessonApi } from "./lesson-api";
import type { LessonPage, LessonSummary, RosterCorrection } from "./lesson-api";
import { useLessonCommand } from "./journal/useLessonCommand";
import { demoName } from "./demo-labels";
import { jm } from "./locales/journal.kk";
import { lm } from "./locales/lesson.kk";
import "./lessons.css";

export function JournalLessonAdmin({
  scope,
  journals,
  csrfToken,
  onExpired,
  onDirtyChange,
  onRefresh,
}: {
  scope: string;
  journals: Journal[];
  csrfToken: string;
  onExpired: () => void;
  onDirtyChange: (value: boolean) => void;
  onRefresh: () => Promise<void>;
}) {
  const [journal, setJournal] = useState("");
  const [page, setPage] = useState<LessonPage | null>(null);
  const [targetPage, setTargetPage] = useState<LessonPage | null>(null);
  const [selected, setSelected] = useState<LessonSummary | null>(null);
  const [roster, setRoster] = useState<RosterCorrection | null>(null);
  const [active, setActive] = useState<string[]>([]);
  const [target, setTarget] = useState<RosterCorrection | null>(null);
  const [targetId, setTargetId] = useState("");
  const [reason, setReason] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const epoch = useRef(0);
  const dirtyCallback = useRef(onDirtyChange);
  dirtyCallback.current = onDirtyChange;
  const dirtyRef = useRef(false);
  const expiry = useRef(onExpired);
  expiry.current = onExpired;
  function denied() {
    setPage(null);
    setRoster(null);
    setSelected(null);
    setTarget(null);
    setTargetPage(null);
    setActive([]);
    setReason("");
    setDirty(false);
    setError(jm.denied);
  }
  function fail(e: unknown) {
    if (e instanceof ApiError && e.status === 401) expiry.current();
    if (e instanceof ApiError && e.status === 403) denied();
    else setError(jm.loadError);
  }
  const command = useLessonCommand({
    scope,
    csrfToken,
    admin: true,
    onExpired,
    onDenied: denied,
    onSaved: async () => {
      setDirty(false);
      await onRefresh();
      await load(journal, page?.offset ?? 0);
    },
  });
  useEffect(() => {
    dirtyRef.current = dirty || command.busy || !!command.pending;
    dirtyCallback.current(dirtyRef.current);
  }, [dirty, command.busy, command.pending]);
  useEffect(
    () => () => {
      ++epoch.current;
      dirtyCallback.current(false);
    },
    [],
  );
  function leave() {
    return !command.busy && (!dirtyRef.current || window.confirm(jm.leave));
  }
  async function load(id: string, offset = 0) {
    const generation = ++epoch.current;
    setSelected(null);
    setRoster(null);
    setTarget(null);
    setTargetId("");
    setReason("");
    setDirty(false);
    setError("");
    setBusy(true);
    setPage(null);
    if (!id) {
      setBusy(false);
      return;
    }
    try {
      const data = await lessonApi.list(scope, id, offset, true);
      if (epoch.current === generation) setPage(data);
    } catch (e) {
      if (epoch.current === generation) fail(e);
    } finally {
      if (epoch.current === generation) setBusy(false);
    }
  }
  async function choose(row: LessonSummary) {
    if (!leave()) return;
    const generation = ++epoch.current;
    setSelected(row);
    setRoster(null);
    setTarget(null);
    setTargetId("");
    setTargetPage(null);
    setReason("");
    setDirty(false);
    setError("");
    command.reset();
    setBusy(true);
    try {
      if (row.lesson_id) {
        const result = await lessonApi.adminRoster(scope, row.lesson_id);
        if (epoch.current === generation) {
          setRoster(result);
          setActive(
            result.students.filter((s) => s.active).map((s) => s.student_id),
          );
        }
      } else {
        const targets = await lessonApi.list(scope, journal, 0, true, true);
        if (epoch.current === generation) setTargetPage(targets);
      }
    } catch (e) {
      if (epoch.current === generation) fail(e);
    } finally {
      if (epoch.current === generation) setBusy(false);
    }
  }
  async function chooseTarget(id: string) {
    const generation = ++epoch.current;
    setTargetId(id);
    setTarget(null);
    setDirty(true);
    setError("");
    if (!id) return;
    setBusy(true);
    try {
      const result = await lessonApi.adminRoster(scope, id);
      if (epoch.current === generation) setTarget(result);
    } catch (e) {
      if (epoch.current === generation) fail(e);
    } finally {
      if (epoch.current === generation) setBusy(false);
    }
  }
  async function targets(offset: number) {
    const generation = ++epoch.current;
    setBusy(true);
    setError("");
    try {
      const data = await lessonApi.list(scope, journal, offset, true, true);
      if (epoch.current === generation) setTargetPage(data);
    } catch (e) {
      if (epoch.current === generation) fail(e);
    } finally {
      if (epoch.current === generation) setBusy(false);
    }
  }
  function reload() {
    if (leave()) {
      command.reset();
      void onRefresh();
      void load(journal, page?.offset ?? 0);
    }
  }
  function save() {
    if (!selected || !page) return;
    const meta = roster ?? target;
    void command.perform({
      operation_id: crypto.randomUUID(),
      expected_revision: meta?.revision ?? 0,
      expected_registry_revision:
        meta?.registry_revision ?? page.registry_revision,
      command: roster
        ? {
            kind: "correct_roster",
            lesson_id: roster.lesson_id,
            student_ids: active,
            reason,
          }
        : {
            kind: "resolve_event",
            journal_id: journal,
            publication_id: selected.publication_id,
            event_id: selected.event_id,
            lesson_id: target?.lesson_id ?? null,
            reason,
          },
    });
  }
  const locked = busy || command.busy || command.stale || !!command.pending;
  return (
    <section className="journal-lessons">
      <div className="panel">
        <h2>{lm.admin}</h2>
        <p>{lm.noDetails}</p>
        <label>
          <span id="lesson-admin-journal-label">{lm.chooseJournal}</span>
          <select
            aria-labelledby="lesson-admin-journal-label"
            value={journal}
            disabled={locked}
            onChange={(e) => {
              if (!leave()) return;
              const id = e.target.value;
              setJournal(id);
              command.reset();
              void load(id);
            }}
          >
            <option value="">{jm.choose}</option>
            {journals.map((j) => (
              <option key={j.id} value={j.id}>
                {demoName(j.subject, j.data_kind)} ·{" "}
                {demoName(j.group, j.data_kind)} · {j.academic_year}
              </option>
            ))}
          </select>
        </label>
      </div>
      {busy && <p role="status">{jm.loading}</p>}
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
          {jm.saved}
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
      {page && !selected && (
        <div className="panel">
          {!page.total ? (
            <p>{lm.empty}</p>
          ) : (
            <>
              <div
                role="region"
                tabIndex={0}
                className="table-scroll"
                aria-label={lm.admin}
              >
                <table>
                  <thead>
                    <tr>
                      <th>{jm.date}</th>
                      <th>{lm.title}</th>
                      <th>{jm.edit}</th>
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
                        <td>{row.recorded ? lm.recorded : lm.planned}</td>
                        <td>
                          {(row.recorded || row.needs_mapping) && (
                            <button
                              className="button button-quiet"
                              onClick={() => void choose(row)}
                            >
                              {row.recorded ? lm.editRoster : lm.resolve}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="lesson-toolbar">
                <button
                  className="button button-quiet"
                  disabled={!page.offset || busy}
                  onClick={() => void load(journal, page.offset - page.limit)}
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
                  disabled={page.offset + page.limit >= page.total || busy}
                  onClick={() => void load(journal, page.offset + page.limit)}
                >
                  {lm.next}
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {selected && (
        <section className="panel">
          <button
            className="button button-quiet"
            disabled={command.busy}
            onClick={reload}
          >
            {lm.back}
          </button>
          <h3>
            {selected.date} · {selected.start}–{selected.end}
          </h3>
          <p>{selected.recorded ? lm.rosterHelp : lm.mappingHelp}</p>
          {(roster || targetPage) && (
            <form
              className="lesson-admin-form"
              onSubmit={(e) => {
                e.preventDefault();
                save();
              }}
            >
              <fieldset disabled={locked}>
                {roster ? (
                  roster.students.map((s) => (
                    <label className="journal-check" key={s.student_id}>
                      <input
                        type="checkbox"
                        checked={active.includes(s.student_id)}
                        onChange={(e) => {
                          setDirty(true);
                          setActive((old) =>
                            e.target.checked
                              ? [...old, s.student_id]
                              : old.filter((id) => id !== s.student_id),
                          );
                        }}
                      />
                      {s.display_name}
                    </label>
                  ))
                ) : (
                  <>
                    <label>
                      <span id="lesson-admin-target-label">{lm.target}</span>
                      <select
                        aria-labelledby="lesson-admin-target-label"
                        value={targetId}
                        onChange={(e) => void chooseTarget(e.target.value)}
                      >
                        <option value="">{lm.newLesson}</option>
                        {target &&
                          !targetPage?.items.some(
                            (r) => r.lesson_id === targetId,
                          ) && (
                            <option value={targetId}>
                              {target.date} · {lm.existingLesson}
                            </option>
                          )}
                        {targetPage?.items.map((row) => (
                          <option key={row.lesson_id} value={row.lesson_id!}>
                            {row.date} · {row.start}–{row.end} · {lm.recorded}
                          </option>
                        ))}
                      </select>
                    </label>
                    {targetPage && (
                      <div className="lesson-toolbar">
                        <button
                          type="button"
                          className="button button-quiet"
                          disabled={!targetPage.offset}
                          onClick={() =>
                            void targets(targetPage.offset - targetPage.limit)
                          }
                        >
                          {lm.previous}
                        </button>
                        <button
                          type="button"
                          className="button button-quiet"
                          disabled={
                            targetPage.offset + targetPage.limit >=
                            targetPage.total
                          }
                          onClick={() =>
                            void targets(targetPage.offset + targetPage.limit)
                          }
                        >
                          {lm.next}
                        </button>
                      </div>
                    )}
                  </>
                )}
                <label>
                  {jm.reason}
                  <input
                    value={reason}
                    required
                    maxLength={500}
                    onChange={(e) => {
                      setReason(e.target.value);
                      setDirty(true);
                    }}
                  />
                </label>
                <button
                  className="button button-primary"
                  type="submit"
                  disabled={!!targetId && !target}
                >
                  {command.busy ? jm.saving : jm.save}
                </button>
              </fieldset>
            </form>
          )}
        </section>
      )}
    </section>
  );
}
