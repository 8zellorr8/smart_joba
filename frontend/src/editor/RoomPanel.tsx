import { useState } from "react";
import type { EditorRoom } from "../editor-api";
import { em } from "../locales/editor.kk";

export function RoomPanel({
  rooms,
  busy,
  onSave,
}: {
  rooms: EditorRoom[];
  busy: boolean;
  onSave: (
    values: Omit<EditorRoom, "id" | "revision">,
    room?: EditorRoom,
  ) => Promise<void>;
}) {
  const [selected, setSelected] = useState<EditorRoom | undefined>();
  const [code, setCode] = useState("");
  const [kind, setKind] = useState("synthetic");
  const [exclusive, setExclusive] = useState("unknown");
  const [confirmed, setConfirmed] = useState(false);
  const [source, setSource] = useState("");
  function choose(room?: EditorRoom) {
    setSelected(room);
    setCode(room?.code ?? "");
    setKind(room?.data_kind ?? "synthetic");
    setExclusive(
      room?.exclusive === null || !room
        ? "unknown"
        : room.exclusive
          ? "yes"
          : "no",
    );
    setConfirmed(room?.confirmed ?? false);
    setSource(room?.source ?? "");
  }
  return (
    <section className="editor-panel">
      <h2>{em.rooms}</h2>
      <p className="editor-help">{em.roomHint}</p>
      <label className="editor-wide-label">
        {em.selectRoom}
        <select
          disabled={busy}
          value={selected?.id ?? ""}
          onChange={(e) => choose(rooms.find((r) => r.id === e.target.value))}
        >
          <option value="">{em.newRoom}</option>
          {rooms.map((r) => (
            <option key={r.id} value={r.id}>
              {r.code} ·{" "}
              {r.data_kind === "synthetic" ? em.synthetic : em.college}
            </option>
          ))}
        </select>
      </label>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void onSave(
            {
              code,
              data_kind: kind,
              exclusive: exclusive === "unknown" ? null : exclusive === "yes",
              confirmed,
              source,
            },
            selected,
          );
        }}
      >
        <div className="editor-grid">
          <label>
            {em.roomCode}
            <input
              value={code}
              required
              maxLength={80}
              disabled={busy || !!selected}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          <label>
            {em.roomKind}
            <select
              value={kind}
              disabled={busy || !!selected}
              onChange={(e) => setKind(e.target.value)}
            >
              <option value="synthetic">{em.synthetic}</option>
              <option value="college">{em.college}</option>
            </select>
          </label>
          <label>
            {em.exclusive}
            <select
              value={exclusive}
              disabled={busy}
              onChange={(e) => {
                setExclusive(e.target.value);
                setConfirmed(false);
              }}
            >
              <option value="unknown">{em.unknown}</option>
              <option value="yes">{em.exclusiveYes}</option>
              <option value="no">{em.exclusiveNo}</option>
            </select>
          </label>
          <label>
            {em.roomSource}
            <input
              value={source}
              required={confirmed}
              maxLength={300}
              disabled={busy}
              onChange={(e) => setSource(e.target.value)}
            />
          </label>
        </div>
        <label className="editor-check">
          <input
            type="checkbox"
            checked={confirmed}
            disabled={busy}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          {em.confirmed}
        </label>
        <button className="button button-primary" disabled={busy}>
          {em.saveRoom}
        </button>
      </form>
    </section>
  );
}
