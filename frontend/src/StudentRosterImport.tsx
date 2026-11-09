import { useMemo, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import type { SetupData } from "./journal-api";
import { demoName } from "./demo-labels";
import { jm } from "./locales/journal.kk";

const MAX_FILE_BYTES = 250_000;
const MAX_STUDENTS = 200;
type PreviewStudent = {
  display_name: string;
  student_id: string | null;
  decision: "new" | "existing" | null;
};

function namesFromText(value: string): string[] {
  const lines = value.replace(/^\uFEFF/, "").split(/\r?\n/);
  const cells = lines.map((line) => line.trim()).filter(Boolean);
  const oneColumnCsvCell = /^"(?:[^"]|"")*"$/;
  if (
    cells.some((line) => /[\t;,]/.test(line) && !oneColumnCsvCell.test(line))
  ) {
    throw new Error("one_column");
  }
  return cells.map((line) =>
    oneColumnCsvCell.test(line)
      ? line.slice(1, -1).replaceAll('""', '"').trim()
      : line,
  );
}

export function StudentRosterImport({
  data,
  busy,
  blocked,
  onDirty,
  onImport,
}: {
  data: SetupData;
  busy: boolean;
  blocked: boolean;
  onDirty: () => void;
  onImport: (command: Record<string, unknown>) => Promise<boolean>;
}) {
  const initialContext =
    data.contexts.find((context) => context.data_kind === "college") ??
    data.contexts[0];
  const [contextId, setContextId] = useState(initialContext?.id ?? "");
  const [groupId, setGroupId] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [source, setSource] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [hasHeader, setHasHeader] = useState(false);
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<PreviewStudent[] | null>(null);
  const [localError, setLocalError] = useState("");
  const [reading, setReading] = useState(false);
  const groups = useMemo(() => {
    const context = data.contexts.find((item) => item.id === contextId);
    return data.groups.filter(
      (group) => group.data_kind === context?.data_kind,
    );
  }, [contextId, data.contexts, data.groups]);
  const contextKind = data.contexts.find(
    (item) => item.id === contextId,
  )?.data_kind;
  const matchingStudents = (name: string) =>
    data.students.filter(
      (student) =>
        student.data_kind === contextKind &&
        student.display_name.toLocaleLowerCase() === name.toLocaleLowerCase(),
    );

  function changed() {
    setPreview(null);
    setLocalError("");
    onDirty();
  }

  async function readFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    changed();
    if (!/\.(txt|csv)$/i.test(file.name)) {
      setLocalError(jm.rosterFileType);
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setLocalError(jm.rosterFileLarge);
      return;
    }
    setReading(true);
    try {
      const content = await file.text();
      if (content.includes("\uFFFD")) {
        setLocalError(jm.rosterEncoding);
        return;
      }
      setText(content.replace(/^\uFEFF/, ""));
    } catch {
      setLocalError(jm.rosterFileError);
    } finally {
      setReading(false);
    }
  }

  function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLocalError("");
    let rows: string[];
    try {
      rows = namesFromText(text);
    } catch {
      setLocalError(jm.rosterOneColumn);
      return;
    }
    if (hasHeader) rows = rows.slice(1);
    if (!rows.length) {
      setLocalError(jm.rosterEmpty);
      return;
    }
    if (rows.length > MAX_STUDENTS) {
      setLocalError(jm.rosterLimit);
      return;
    }
    if (rows.some((name) => name.length > 160)) {
      setLocalError(jm.rosterNameLong);
      return;
    }
    setPreview(
      rows.map((display_name) => ({
        display_name,
        student_id: null,
        decision: matchingStudents(display_name).length ? null : "new",
      })),
    );
  }

  async function importNow() {
    if (!preview || !confirmed) return;
    const ok = await onImport({
      kind: "import_roster",
      context_id: contextId,
      group_id: groupId,
      start,
      end,
      source,
      confirmed: true,
      students: preview.map(({ display_name, student_id }) => ({
        display_name,
        student_id,
      })),
    });
    if (ok) {
      setText("");
      setPreview(null);
      setSource("");
      setConfirmed(false);
      setHasHeader(false);
    }
  }

  return (
    <section
      className="panel journal-form"
      aria-labelledby="roster-import-title"
    >
      <h2 id="roster-import-title">{jm.rosterImport}</h2>
      <p className="journal-note">{jm.rosterImportHelp}</p>
      <form onSubmit={prepare}>
        <fieldset disabled={busy || blocked || reading}>
          <label htmlFor="roster-file">
            <span>{jm.rosterFile}</span>
            <input
              id="roster-file"
              type="file"
              accept=".txt,.csv,text/plain,text/csv"
              onChange={(event) => void readFile(event)}
            />
          </label>
          <label htmlFor="roster-names">
            <span>{jm.rosterNames}</span>
            <textarea
              id="roster-names"
              rows={7}
              value={text}
              onChange={(event) => {
                changed();
                setText(event.currentTarget.value);
              }}
              required
            />
          </label>
          <label className="journal-check" htmlFor="roster-has-header">
            <span>{jm.rosterHasHeader}</span>
            <input
              id="roster-has-header"
              type="checkbox"
              checked={hasHeader}
              onChange={(event) => {
                changed();
                setHasHeader(event.currentTarget.checked);
              }}
            />
          </label>
          <label htmlFor="roster-context">
            <span>{jm.context}</span>
            <select
              id="roster-context"
              value={contextId}
              onChange={(event) => {
                changed();
                setContextId(event.currentTarget.value);
                setGroupId("");
              }}
              required
            >
              <option value="">{jm.choose}</option>
              {data.contexts.map((context) => (
                <option key={context.id} value={context.id}>
                  {context.academic_year} ·{" "}
                  {context.data_kind === "synthetic"
                    ? jm.synthetic
                    : jm.college}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor="roster-group">
            <span>{jm.group}</span>
            <select
              id="roster-group"
              value={groupId}
              onChange={(event) => {
                changed();
                setGroupId(event.currentTarget.value);
              }}
              required
            >
              <option value="">{jm.choose}</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {demoName(group.code, group.data_kind)}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor="roster-start">
            <span>{jm.start}</span>
            <input
              id="roster-start"
              type="date"
              value={start}
              onChange={(event) => {
                changed();
                setStart(event.currentTarget.value);
              }}
              required
            />
          </label>
          <label htmlFor="roster-end">
            <span>{jm.end}</span>
            <input
              id="roster-end"
              type="date"
              value={end}
              onChange={(event) => {
                changed();
                setEnd(event.currentTarget.value);
              }}
              required
            />
          </label>
          <label htmlFor="roster-source">
            <span>{jm.source}</span>
            <input
              id="roster-source"
              type="text"
              maxLength={300}
              value={source}
              onChange={(event) => {
                changed();
                setSource(event.currentTarget.value);
              }}
              required
            />
          </label>
          <label className="journal-check" htmlFor="roster-confirmed">
            <span>{jm.rosterConfirm}</span>
            <input
              id="roster-confirmed"
              type="checkbox"
              checked={confirmed}
              onChange={(event) => {
                onDirty();
                setConfirmed(event.currentTarget.checked);
              }}
            />
          </label>
          <button className="button button-primary" type="submit">
            {reading ? jm.rosterReading : jm.rosterPreview}
          </button>
        </fieldset>
      </form>
      {localError && <p role="alert">{localError}</p>}
      {preview && (
        <div className="roster-preview">
          <p role="status">
            {jm.rosterPreviewCount.replace("{count}", String(preview.length))}
          </p>
          <ol aria-label={jm.rosterPreview}>
            {preview.map((entry, index) => {
              const candidates = matchingStudents(entry.display_name);
              return (
                <li key={`${index}-${entry.display_name}`}>
                  {entry.display_name}
                  {candidates.length > 0 && (
                    <label className="roster-match">
                      <span className="sr-only">
                        {jm.rosterMatch.replace("{number}", String(index + 1))}
                      </span>
                      <select
                        aria-label={jm.rosterMatch.replace(
                          "{number}",
                          String(index + 1),
                        )}
                        value={
                          entry.decision === "new"
                            ? "__new__"
                            : (entry.student_id ?? "")
                        }
                        required
                        disabled={busy || blocked}
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          const student_id =
                            value === "__new__" ? null : value || null;
                          setPreview(
                            (current) =>
                              current?.map((item, itemIndex) =>
                                itemIndex === index
                                  ? {
                                      ...item,
                                      student_id,
                                      decision:
                                        value === "__new__"
                                          ? "new"
                                          : value
                                            ? "existing"
                                            : null,
                                    }
                                  : item,
                              ) ?? null,
                          );
                          onDirty();
                        }}
                      >
                        <option value="" disabled>
                          {jm.rosterChooseProfile}
                        </option>
                        <option value="__new__">{jm.rosterCreateNew}</option>
                        {candidates.map((student) => {
                          const previousMembership = data.memberships.find(
                            (item) => item.student_id === student.id,
                          );
                          return (
                            <option key={student.id} value={student.id}>
                              {demoName(
                                student.display_name,
                                student.data_kind,
                              )}
                              {previousMembership
                                ? ` · ${demoName(previousMembership.group, student.data_kind)} · ${previousMembership.academic_year}`
                                : ` · ${jm.noMemberships}`}
                            </option>
                          );
                        })}
                      </select>
                    </label>
                  )}
                </li>
              );
            })}
          </ol>
          <button
            className="button button-primary"
            type="button"
            disabled={
              busy ||
              blocked ||
              !confirmed ||
              preview.some((entry) => entry.decision === null) ||
              !groupId ||
              !start ||
              !end ||
              !source.trim()
            }
            onClick={() => void importNow()}
          >
            {busy
              ? jm.saving
              : jm.rosterCommit.replace("{count}", String(preview.length))}
          </button>
        </div>
      )}
    </section>
  );
}
