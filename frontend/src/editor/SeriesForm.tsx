import { useState } from "react";
import type { FormEvent } from "react";
import type {
  DraftSeries,
  EditorData,
  ScheduleDraft,
  SeriesValues,
} from "../editor-api";
import { em } from "../locales/editor.kk";
import { weekdays } from "../locales/calendar.kk";
import { demoName } from "../demo-labels";

const splitDates = (value: string) => value.split(/[,\s]+/).filter(Boolean);
export function SeriesForm({
  draft,
  data,
  selected,
  busy,
  onSave,
  onClose,
}: {
  draft: ScheduleDraft;
  data: EditorData;
  selected?: DraftSeries;
  busy: boolean;
  onSave: (values: SeriesValues, id?: string) => void;
  onClose: () => void;
}) {
  const assignments = data.assignments.filter(
    (a) => a.context_id === draft.context_id,
  );
  const [assignmentId, setAssignment] = useState(
    selected?.template.assignment_id ?? assignments[0]?.id ?? "",
  );
  const assignment = assignments.find((a) => a.id === assignmentId);
  const calendars = data.calendars.filter(
    (c) =>
      c.context_id === draft.context_id && c.group_id === assignment?.group_id,
  );
  const calendar = calendars[0];
  const rooms = data.rooms.filter((r) => r.data_kind === draft.data_kind);
  const [roomId, setRoom] = useState(
    selected?.template.room_id ?? rooms[0]?.id ?? "",
  );
  const [slotId, setSlot] = useState(
    selected?.template.pattern.slot_id ?? calendar?.document.slots[0]?.id ?? "",
  );
  const [start, setStart] = useState(selected?.template.pattern.start ?? "");
  const [end, setEnd] = useState(selected?.template.pattern.end ?? "");
  const [days, setDays] = useState(selected?.template.pattern.weekdays ?? [1]);
  const [mode, setMode] = useState(
    selected?.template.pattern.dates.length ? "explicit" : "weekly",
  );
  const [dates, setDates] = useState(
    selected?.template.pattern.dates.join(", ") ?? "",
  );
  const [cancelled, setCancelled] = useState(
    selected?.template.pattern.cancelled_dates.join(", ") ?? "",
  );
  const room = rooms.find((r) => r.id === roomId);
  const validSlot = calendar?.document.slots.find((s) => s.id === slotId);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!assignment || !calendar || !room || !validSlot) return;
    onSave(
      {
        assignment_id: assignment.id,
        assignment_revision: assignment.revision,
        calendar_id: calendar.id,
        calendar_revision: calendar.revision,
        room_id: room.id,
        room_revision: room.revision,
        pattern: {
          id: selected?.template.pattern.id ?? "manual",
          start,
          end,
          slot_id: slotId,
          weekdays: mode === "weekly" ? days : [],
          dates: mode === "explicit" ? splitDates(dates) : [],
          cancelled_dates: splitDates(cancelled),
        },
      },
      selected?.id,
    );
  }
  return (
    <form
      className="editor-panel"
      onSubmit={submit}
      aria-label={selected ? em.seriesEdit : em.createSeries}
    >
      <div className="editor-panel-heading">
        <h2>{selected ? em.seriesEdit : em.createSeries}</h2>
        <button
          type="button"
          className="editor-link"
          onClick={onClose}
          disabled={busy}
        >
          {em.close}
        </button>
      </div>
      {selected && <p className="editor-help">{em.seriesHint}</p>}
      {!assignments.length && <p className="notice">{em.noAssignment}</p>}
      <div className="editor-grid">
        <label>
          {em.assignment}
          <select
            value={assignmentId}
            required
            disabled={busy}
            onChange={(e) => {
              setAssignment(e.target.value);
              const next = assignments.find((a) => a.id === e.target.value);
              setSlot(
                data.calendars.find(
                  (c) =>
                    c.context_id === draft.context_id &&
                    c.group_id === next?.group_id,
                )?.document.slots[0]?.id ?? "",
              );
            }}
          >
            <option value="">—</option>
            {assignments.map((a) => (
              <option key={a.id} value={a.id}>
                {demoName(a.group, draft.data_kind)} ·{" "}
                {demoName(a.subject, draft.data_kind)} ·{" "}
                {demoName(a.teacher, draft.data_kind)} · {em.semester}{" "}
                {a.semester}
              </option>
            ))}
          </select>
        </label>
        <label>
          {em.room}
          <select
            value={roomId}
            required
            disabled={busy}
            onChange={(e) => setRoom(e.target.value)}
          >
            <option value="">—</option>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {demoName(r.code, r.data_kind)}
                {!r.confirmed || r.exclusive === null ? ` · ${em.unknown}` : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          {em.time}
          <select
            value={slotId}
            required
            disabled={busy}
            onChange={(e) => setSlot(e.target.value)}
          >
            <option value="">—</option>
            {calendar?.document.slots.map((s) => (
              <option key={s.id} value={s.id}>
                {demoName(s.label, draft.data_kind)} · {s.start}–{s.end}
              </option>
            ))}
          </select>
        </label>
        <label>
          {em.start}
          <input
            type="date"
            value={start}
            required
            disabled={busy}
            onChange={(e) => setStart(e.target.value)}
          />
        </label>
        <label>
          {em.end}
          <input
            type="date"
            value={end}
            required
            disabled={busy}
            onChange={(e) => setEnd(e.target.value)}
          />
        </label>
        <label>
          {em.repeatMode}
          <select
            value={mode}
            disabled={busy}
            onChange={(e) => setMode(e.target.value)}
          >
            <option value="weekly">{em.weekly}</option>
            <option value="explicit">{em.explicit}</option>
          </select>
        </label>
      </div>
      {!calendar && <p className="notice">{em.noCalendar}</p>}
      {mode === "weekly" ? (
        <fieldset className="editor-weekdays">
          <legend>{em.weekdays}</legend>
          {weekdays.map((label, index) => (
            <label key={label}>
              <input
                type="checkbox"
                checked={days.includes(index)}
                disabled={busy}
                onChange={(e) =>
                  setDays(
                    e.target.checked
                      ? [...days, index]
                      : days.filter((d) => d !== index),
                  )
                }
              />
              {label}
            </label>
          ))}
        </fieldset>
      ) : (
        <label className="editor-wide-label">
          {em.dates}
          <textarea
            value={dates}
            required
            disabled={busy}
            onChange={(e) => setDates(e.target.value)}
          />
          <small>{em.datesHint}</small>
        </label>
      )}
      <label className="editor-wide-label">
        {em.cancelledDates}
        <input
          value={cancelled}
          disabled={busy}
          onChange={(e) => setCancelled(e.target.value)}
        />
        <small>{em.datesHint}</small>
      </label>
      <button
        className="button button-primary"
        disabled={
          busy ||
          !assignment ||
          !calendar ||
          !room ||
          !validSlot ||
          (mode === "weekly" && !days.length)
        }
      >
        {em.saveSeries}
      </button>
    </form>
  );
}
