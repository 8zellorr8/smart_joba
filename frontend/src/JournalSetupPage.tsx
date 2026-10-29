import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { ApiError } from "./api";
import { journalApi } from "./journal-api";
import type { SetupCommand, SetupData } from "./journal-api";
import { jm } from "./locales/journal.kk";
import { PageHeading } from "./ui/PageHeading";
import { demoName } from "./demo-labels";
import "./journal.css";

type Field = {
  name: string;
  label: string;
  type?: "text" | "date" | "checkbox";
  value?: string | boolean;
  options?: { value: string; label: string }[];
  optional?: boolean;
  max?: number;
};
type Props = {
  scope: string;
  csrfToken: string;
  onExpired: () => void;
  onDirtyChange: (dirty: boolean) => void;
};
const kindLabel = (kind: string) =>
  kind === "synthetic" ? jm.synthetic : jm.college;
const evidence: Field[] = [
  { name: "source", label: jm.source, max: 300 },
  { name: "confirmed", label: jm.confirmed, type: "checkbox" },
  { name: "reason", label: jm.reason, optional: true, max: 500 },
];
const dates: Field[] = [
  { name: "start", label: jm.start, type: "date" },
  { name: "end", label: jm.end, type: "date" },
];

export function SetupForm({
  title,
  fields,
  busy,
  blocked,
  error,
  fieldError,
  onSubmit,
  onDirty,
  children,
}: {
  title: string;
  fields: Field[];
  busy: boolean;
  blocked: boolean;
  error: string;
  fieldError: string;
  onSubmit: (values: Record<string, string | boolean>) => Promise<boolean>;
  onDirty: () => void;
  children?: ReactNode;
}) {
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const values = Object.fromEntries(
      fields.map((f) => [
        f.name,
        f.type === "checkbox"
          ? data.has(f.name)
          : String(data.get(f.name) ?? ""),
      ]),
    );
    if (await onSubmit(values)) form.reset();
  }
  return (
    <section className="panel journal-form">
      <h2>{title}</h2>
      <form onSubmit={(e) => void submit(e)} onChange={onDirty}>
        <fieldset disabled={busy || blocked}>
          {fields.map((f) => (
            <label
              key={f.name}
              htmlFor={`journal-${f.name}`}
              className={f.type === "checkbox" ? "journal-check" : ""}
            >
              <span id={`journal-label-${f.name}`}>{f.label}</span>
              {f.options ? (
                <select
                  id={`journal-${f.name}`}
                  aria-labelledby={`journal-label-${f.name}`}
                  name={f.name}
                  defaultValue={String(f.value ?? "")}
                  required={!f.optional}
                  aria-invalid={fieldError === f.name || undefined}
                  aria-describedby={
                    fieldError === f.name ? "journal-field-error" : undefined
                  }
                >
                  <option value="">
                    {f.optional ? jm.unbound : jm.choose}
                  </option>
                  {f.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={`journal-${f.name}`}
                  aria-labelledby={`journal-label-${f.name}`}
                  name={f.name}
                  type={f.type ?? "text"}
                  defaultValue={
                    f.type === "checkbox" ? undefined : String(f.value ?? "")
                  }
                  defaultChecked={
                    f.type === "checkbox" ? Boolean(f.value) : undefined
                  }
                  required={!f.optional}
                  maxLength={f.max ?? 160}
                  aria-invalid={fieldError === f.name || undefined}
                  aria-describedby={
                    fieldError === f.name ? "journal-field-error" : undefined
                  }
                />
              )}
              {fieldError === f.name && (
                <span id="journal-field-error" className="error-message">
                  {error}
                </span>
              )}
            </label>
          ))}
          <button className="button button-primary" type="submit">
            {busy ? jm.saving : jm.save}
          </button>
        </fieldset>
      </form>
      {children}
    </section>
  );
}

export function JournalSetupPage({
  scope,
  csrfToken,
  onExpired,
  onDirtyChange,
}: Props) {
  const [data, setData] = useState<SetupData | null>(null);
  const [tab, setTab] = useState("students");
  const [selected, setSelected] = useState("");
  const [edit, setEdit] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [pending, setPending] = useState<SetupCommand | null>(null);
  const dirty = useRef(false);
  const alive = useRef(true);
  const errorRef = useRef<HTMLDivElement>(null);
  const expired = useRef(onExpired);
  expired.current = onExpired;
  const changeDirty = (value: boolean) => {
    dirty.current = value;
    onDirtyChange(value);
  };
  const load = useCallback(async () => {
    setLoadError("");
    try {
      const result = await journalApi.setup(scope);
      if (alive.current) setData(result);
    } catch (e) {
      if (!alive.current) return;
      if (e instanceof ApiError && e.status === 401) expired.current();
      setData(null);
      setLoadError(
        e instanceof ApiError && e.status === 403 ? jm.denied : jm.loadError,
      );
    }
  }, [scope]);
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  async function perform(body: SetupCommand): Promise<boolean> {
    setBusy(true);
    setError("");
    setFieldError("");
    setSaved(false);
    try {
      await journalApi.command(scope, csrfToken, body);
      if (!alive.current) return false;
      setPending(null);
      changeDirty(false);
      setSaved(true);
      setStale(false);
      await load();
      setRefreshKey((key) => key + 1);
      return true;
    } catch (e) {
      if (!alive.current) return false;
      if (e instanceof ApiError && e.status === 401) expired.current();
      if (e instanceof ApiError && e.status === 403) {
        setData(null);
        setPending(null);
        changeDirty(false);
        setLoadError(jm.denied);
      } else if (
        !(e instanceof ApiError) ||
        e.status === 0 ||
        e.status >= 500
      ) {
        setPending(body);
        changeDirty(true);
        setError(jm.uncertain);
      } else {
        setPending(null);
        setStale(
          e.code === "JOURNAL_STALE" || e.code === "JOURNAL_OPERATION_CONFLICT",
        );
        setError(
          e.code === "JOURNAL_STALE"
            ? jm.stale
            : (jm.errors[e.code] ?? jm.loadError),
        );
        setFieldError(typeof e.params.field === "string" ? e.params.field : "");
      }
      requestAnimationFrame(() => errorRef.current?.focus());
      return false;
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const save = async (command: Record<string, unknown>) =>
    data
      ? perform({
          operation_id: crypto.randomUUID(),
          expected_revision: data.revision,
          command,
        })
      : false;
  function navigate(nextTab: string, nextSelected = "", nextEdit = "") {
    if (busy || pending) return;
    if (dirty.current && !window.confirm(jm.leave)) return;
    changeDirty(false);
    setTab(nextTab);
    setSelected(nextSelected);
    setEdit(nextEdit);
    setError("");
    setFieldError("");
    setSaved(false);
    setStale(false);
    setRefreshKey((key) => key + 1);
  }
  async function reload() {
    if (pending || busy || (dirty.current && !window.confirm(jm.reloadConfirm)))
      return;
    changeDirty(false);
    setError("");
    setFieldError("");
    setStale(false);
    await load();
    setRefreshKey((key) => key + 1);
  }
  function form(
    title: string,
    fields: Field[],
    submit: (v: Record<string, string | boolean>) => Record<string, unknown>,
  ) {
    return (
      <SetupForm
        key={`${tab}-${selected}-${edit}-${refreshKey}`}
        title={title}
        fields={fields}
        busy={busy}
        blocked={stale || Boolean(pending)}
        error={error}
        fieldError={fieldError}
        onDirty={() => {
          changeDirty(true);
          setSaved(false);
        }}
        onSubmit={(v) => save(submit(v))}
      />
    );
  }
  const table = (label: string, headers: string[], rows: ReactNode[]) => (
    <div className="table-scroll" role="region" aria-label={label} tabIndex={0}>
      <table>
        <thead>
          <tr>
            {headers.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>
    </div>
  );
  const button = (label: string, action: () => void) => (
    <button
      className="button button-quiet"
      disabled={busy || Boolean(pending)}
      onClick={action}
    >
      {label}
    </button>
  );
  if (!data)
    return (
      <div className="journal-page">
        <PageHeading
          id="journal-title"
          eyebrow={jm.foundation}
          title={jm.setup}
          description={jm.setupDescription}
        />
        {saved && <p role="status">{jm.saved}</p>}
        {loadError ? (
          <div role="alert">
            <p>{loadError}</p>
            <button className="button button-quiet" onClick={() => void load()}>
              {jm.retry}
            </button>
          </div>
        ) : (
          <p role="status">{jm.loading}</p>
        )}
      </div>
    );
  const student = data.students.find((s) => s.id === selected);
  const membership = data.memberships.find((m) => m.id === edit);
  const binding = data.bindings.find((b) => b.user_id === selected);
  const journal = data.journals.find((j) => j.id === selected);
  const assigned = data.assignments.find((a) => a.id === edit);
  const studentOptions = data.students.map((s) => ({
    value: s.id,
    label: `${s.display_name} · ${kindLabel(s.data_kind)}`,
  }));
  const groupName = (id: string) => {
    const group = data.groups.find((g) => g.id === id);
    return demoName(group?.code ?? id, group?.data_kind);
  };
  const teacherName = (id: string) => {
    const teacher = data.teachers.find((t) => t.id === id);
    return demoName(teacher?.display_name ?? id, teacher?.data_kind);
  };
  const filledEvidence = (source = "", changed = false) =>
    evidence.map((f) => ({
      ...f,
      value: f.name === "source" ? source : undefined,
      optional: f.name === "reason" ? !changed : f.optional,
    }));

  return (
    <div className="journal-page">
      <PageHeading
        id="journal-title"
        eyebrow={jm.foundation}
        title={jm.setup}
        description={jm.setupDescription}
      />
      <p className="journal-note">{jm.next}</p>
      <nav className="journal-tabs" aria-label={jm.setup}>
        {[
          ["students", jm.students],
          ["memberships", jm.memberships],
          ["bindings", jm.bindings],
          ["journals", jm.journals],
        ].map(([key, label]) => (
          <button
            key={key}
            aria-current={tab === key ? "page" : undefined}
            disabled={busy || Boolean(pending)}
            onClick={() => navigate(key)}
          >
            {label}
          </button>
        ))}
      </nav>
      {saved && (
        <p role="status" className="success-message">
          {jm.saved}
        </p>
      )}
      {error && (
        <div
          ref={errorRef}
          tabIndex={-1}
          role="alert"
          className="journal-error"
        >
          <p>{error}</p>
          {fieldError && <a href={`#journal-${fieldError}`}>{jm.edit}</a>}
          {pending && (
            <button
              className="button button-primary"
              disabled={busy}
              onClick={() => void perform(pending)}
            >
              {jm.retrySave}
            </button>
          )}
          {stale && (
            <button
              className="button button-quiet"
              onClick={() => void reload()}
            >
              {jm.retry}
            </button>
          )}
        </div>
      )}
      {tab === "students" && (
        <div className="journal-layout">
          <section className="panel">
            <div className="journal-section-title">
              <h2>{jm.students}</h2>
              {selected && button(jm.addStudent, () => navigate(tab))}
            </div>
            {data.students.length ? (
              table(
                jm.students,
                [jm.student, jm.kind, jm.edit],
                data.students.map((s) => (
                  <tr key={s.id}>
                    <td>{s.display_name}</td>
                    <td>{kindLabel(s.data_kind)}</td>
                    <td>{button(jm.edit, () => navigate(tab, s.id))}</td>
                  </tr>
                )),
              )
            ) : (
              <p>{jm.emptyStudents}</p>
            )}
          </section>
          {form(
            student ? jm.editStudent : jm.addStudent,
            [
              {
                name: "display_name",
                label: jm.name,
                value: student?.display_name,
              },
              ...(student
                ? [{ name: "reason", label: jm.reason, max: 500 }]
                : [
                    {
                      name: "data_kind",
                      label: jm.kind,
                      options: [
                        { value: "synthetic", label: jm.synthetic },
                        { value: "college", label: jm.college },
                      ],
                    },
                  ]),
            ],
            (v) =>
              student
                ? { kind: "rename_student", student_id: student.id, ...v }
                : { kind: "create_student", ...v },
          )}
        </div>
      )}
      {tab === "memberships" && (
        <>
          <p className="journal-note">{jm.intervalHelp}</p>
          <div className="journal-layout">
            <section className="panel">
              <div className="journal-section-title">
                <h2>{jm.memberships}</h2>
                {edit && button(jm.addMembership, () => navigate(tab))}
              </div>
              {data.memberships.length ? (
                table(
                  jm.memberships,
                  [jm.student, jm.group, jm.start, jm.end, jm.edit],
                  data.memberships.map((m) => (
                    <tr key={m.id}>
                      <td>
                        {
                          data.students.find((s) => s.id === m.student_id)
                            ?.display_name
                        }
                      </td>
                      <td>
                        {groupName(m.group_id)}
                        <small>{m.academic_year}</small>
                      </td>
                      <td>{m.start}</td>
                      <td>{m.end}</td>
                      <td>
                        {button(jm.edit, () => navigate(tab, "", m.id))}
                        {button(jm.sync, () => navigate(tab, m.id, "sync"))}
                      </td>
                    </tr>
                  )),
                )
              ) : (
                <p>{jm.noMemberships}</p>
              )}
            </section>
            {edit === "sync"
              ? form(
                  jm.sync,
                  [{ name: "reason", label: jm.reason, max: 500 }],
                  (v) => ({
                    kind: "sync_schedule_group",
                    membership_id: selected,
                    ...v,
                  }),
                )
              : form(
                  membership ? jm.editMembership : jm.addMembership,
                  [
                    {
                      name: "student_id",
                      label: jm.student,
                      options: studentOptions,
                      value: membership?.student_id,
                    },
                    {
                      name: "context_id",
                      label: jm.context,
                      value: membership?.context_id,
                      options: data.contexts.map((c) => ({
                        value: c.id,
                        label: `${c.academic_year} · ${kindLabel(c.data_kind)}`,
                      })),
                    },
                    {
                      name: "group_id",
                      label: jm.group,
                      value: membership?.group_id,
                      options: data.groups.map((g) => ({
                        value: g.id,
                        label: `${groupName(g.id)} · ${kindLabel(g.data_kind)}`,
                      })),
                    },
                    ...dates.map((f) => ({
                      ...f,
                      value:
                        f.name === "start"
                          ? membership?.start
                          : membership?.end,
                    })),
                    ...filledEvidence(membership?.source, Boolean(membership)),
                  ],
                  (v) => ({
                    kind: "save_membership",
                    id: membership?.id ?? null,
                    ...v,
                  }),
                )}
          </div>
          {edit === "sync" && <p className="journal-note">{jm.syncHelp}</p>}
        </>
      )}
      {tab === "bindings" && (
        <>
          <p className="journal-note">{jm.bindingHelp}</p>
          <div className="journal-layout">
            <section className="panel">
              <h2>{jm.bindings}</h2>
              {table(
                jm.bindings,
                [jm.account, jm.currentStudent, jm.edit],
                data.accounts.map((a) => {
                  const b = data.bindings.find((b) => b.user_id === a.id);
                  return (
                    <tr key={a.id}>
                      <td>
                        {a.display_name}
                        <small>{a.email}</small>
                      </td>
                      <td>
                        {data.students.find((s) => s.id === b?.student_id)
                          ?.display_name ?? jm.noStudent}
                      </td>
                      <td>{button(jm.edit, () => navigate(tab, a.id))}</td>
                    </tr>
                  );
                }),
              )}
            </section>
            {form(
              jm.bind,
              [
                {
                  name: "user_id",
                  label: jm.account,
                  value: selected,
                  options: data.accounts.map((a) => ({
                    value: a.id,
                    label: `${a.display_name} · ${a.email}`,
                  })),
                },
                {
                  name: "student_id",
                  label: jm.student,
                  optional: true,
                  value: binding?.student_id ?? "",
                  options: studentOptions,
                },
                ...filledEvidence(binding?.source, Boolean(binding)),
              ],
              (v) => ({
                kind: "bind_account",
                ...v,
                student_id: v.student_id || null,
              }),
            )}
          </div>
        </>
      )}
      {tab === "journals" && (
        <div className="journal-layout">
          <section className="panel">
            <div className="journal-section-title">
              <h2>{jm.journals}</h2>
              {selected && button(jm.newJournal, () => navigate(tab))}
            </div>
            {data.journals.length ? (
              <div className="journal-catalog">
                {data.journals.map((j) => (
                  <article key={j.id}>
                    <h3>{demoName(j.subject, j.data_kind)}</h3>
                    <p>
                      {demoName(j.group, j.data_kind)} · {j.academic_year} ·{" "}
                      {j.semester} {jm.semester}
                    </p>
                    {button(jm.addAssignment, () => navigate(tab, j.id))}
                    {data.assignments
                      .filter((a) => a.journal_id === j.id)
                      .map((a) => (
                        <div key={a.id} className="journal-assignment">
                          <strong>{teacherName(a.teacher_id)}</strong>
                          <span>
                            {a.start} — {a.end}
                          </span>
                          <span>{a.active ? jm.assigned : jm.revoked}</span>
                          {button(jm.editAssignment, () =>
                            navigate(tab, j.id, a.id),
                          )}
                        </div>
                      ))}
                  </article>
                ))}
              </div>
            ) : (
              <p>{jm.emptyJournals}</p>
            )}
          </section>
          {journal ? (
            form(
              assigned ? jm.editAssignment : jm.addAssignment,
              [
                {
                  name: "teacher_id",
                  label: jm.teacher,
                  value: assigned?.teacher_id,
                  options: data.teachers
                    .filter((t) => t.data_kind === journal.data_kind)
                    .map((t) => ({ value: t.id, label: teacherName(t.id) })),
                },
                ...dates.map((f) => ({
                  ...f,
                  value: f.name === "start" ? assigned?.start : assigned?.end,
                })),
                {
                  name: "active",
                  label: jm.active,
                  type: "checkbox",
                  optional: true,
                  value: assigned?.active ?? true,
                },
                ...filledEvidence(assigned?.source, Boolean(assigned)),
              ],
              (v) => ({
                kind: "save_assignment",
                id: assigned?.id ?? null,
                journal_id: journal.id,
                ...v,
              }),
            )
          ) : data.demands.length ? (
            form(
              jm.newJournal,
              [
                {
                  name: "demand_id",
                  label: jm.demand,
                  options: data.demands.map((d) => ({
                    value: d.id,
                    label: `${demoName(d.subject, data.contexts.find((c) => c.id === d.context_id)?.data_kind)} · ${groupName(d.group_id)} · ${data.contexts.find((c) => c.id === d.context_id)?.academic_year} · ${d.semester} ${jm.semester}`,
                  })),
                },
                ...filledEvidence(),
              ],
              (v) => ({ kind: "create_journal", ...v }),
            )
          ) : (
            <p className="panel">{jm.noDemands}</p>
          )}
        </div>
      )}
    </div>
  );
}
