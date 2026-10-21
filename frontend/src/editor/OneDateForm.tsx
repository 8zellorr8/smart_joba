import { useState } from "react";
import type { DraftOccurrence, EditorData } from "../editor-api";
import { em } from "../locales/editor.kk";

export interface OneDateValues {
  date: string;
  start: string;
  end: string;
  room_id: string;
  room_revision: number;
  cancelled: boolean;
  pinned: boolean;
}
export function OneDateForm({
  event,
  data,
  kind,
  busy,
  onSave,
  onClose,
}: {
  event: DraftOccurrence;
  data: EditorData;
  kind: string;
  busy: boolean;
  onSave: (values: OneDateValues) => void;
  onClose: () => void;
}) {
  const [date, setDate] = useState(event.date);
  const [time, setTime] = useState(`${event.start}|${event.end}`);
  const [roomId, setRoom] = useState(event.room_id);
  const [cancelled, setCancelled] = useState(event.cancelled);
  const [pinned, setPinned] = useState(event.pinned);
  const room = data.rooms.find((r) => r.id === roomId);
  const slots =
    data.calendars.find((c) => c.id === event.calendar_id)?.document.slots ??
    [];
  return (
    <form
      className="editor-panel"
      aria-label={em.oneEdit}
      onSubmit={(e) => {
        e.preventDefault();
        if (!room) return;
        const [start, end] = time.split("|");
        onSave({
          date,
          start,
          end,
          room_id: roomId,
          room_revision: room.revision,
          cancelled,
          pinned,
        });
      }}
    >
      <div className="editor-panel-heading">
        <h2>{em.oneEdit}</h2>
        <button
          className="editor-link"
          type="button"
          onClick={onClose}
          disabled={busy}
        >
          {em.close}
        </button>
      </div>
      <p className="editor-help">{em.oneHint}</p>
      <p>
        {event.group} · {event.subject} · {event.teacher}
      </p>
      <div className="editor-grid">
        <label>
          {em.date}
          <input
            type="date"
            value={date}
            required
            disabled={busy}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <label>
          {em.time}
          <select
            value={time}
            required
            disabled={busy}
            onChange={(e) => setTime(e.target.value)}
          >
            {!slots.some((s) => `${s.start}|${s.end}` === time) && (
              <option value={time}>
                {time.replace("|", "–")} · {em.unknown}
              </option>
            )}
            {slots.map((s) => (
              <option key={s.id} value={`${s.start}|${s.end}`}>
                {s.label} · {s.start}–{s.end}
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
            {data.rooms
              .filter((r) => r.data_kind === kind)
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.code}
                </option>
              ))}
          </select>
        </label>
      </div>
      <div className="editor-actions">
        <label className="editor-check">
          <input
            type="checkbox"
            checked={cancelled}
            disabled={busy}
            onChange={(e) => setCancelled(e.target.checked)}
          />
          {em.cancelled}
        </label>
        <label className="editor-check">
          <input
            type="checkbox"
            checked={pinned}
            disabled={busy}
            onChange={(e) => setPinned(e.target.checked)}
          />
          {em.pinned}
        </label>
      </div>
      <button className="button button-primary" disabled={busy || !room}>
        {em.saveOne}
      </button>
    </form>
  );
}
