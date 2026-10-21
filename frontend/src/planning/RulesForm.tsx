import { useEffect, useState } from "react";
import type {
  PlanningData,
  RulesDocument,
  Availability,
  BusyInterval,
} from "../planning-api";
import { pm } from "../locales/planning.kk";

function blank(
  data: PlanningData,
  context: PlanningData["contexts"][number],
): RulesDocument {
  return {
    confirmed: false,
    source: "",
    external_confirmed: false,
    external_source: "",
    groups: data.groups
      .filter(
        (g) =>
          g.data_kind === context.data_kind &&
          data.demands.some(
            (d) => d.context_id === context.id && d.group_id === g.id,
          ),
      )
      .map((g) => ({ group_id: g.id, size: null })),
    rooms: data.rooms
      .filter((r) => r.data_kind === context.data_kind)
      .map((r) => ({ room_id: r.id, capacity: null, features: [] })),
    needs: data.demands
      .filter((d) => d.context_id === context.id)
      .map((d) => ({ demand_id: d.id, features: [] })),
    availability: [],
    busy: [],
  };
}
function initialRules(
  data: PlanningData,
  context: PlanningData["contexts"][number],
): RulesDocument {
  const defaults = blank(data, context);
  const saved = context.rules;
  if (!saved) return defaults;
  const groups = defaults.groups.map(
    (g) => saved.groups.find((v) => v.group_id === g.group_id) ?? g,
  );
  const rooms = defaults.rooms.map(
    (r) => saved.rooms.find((v) => v.room_id === r.room_id) ?? r,
  );
  const needs = defaults.needs.map(
    (n) => saved.needs.find((v) => v.demand_id === n.demand_id) ?? n,
  );
  const changed =
    groups.length !== saved.groups.length ||
    rooms.length !== saved.rooms.length ||
    needs.length !== saved.needs.length ||
    groups.some((g) => !saved.groups.some((v) => v.group_id === g.group_id)) ||
    rooms.some((r) => !saved.rooms.some((v) => v.room_id === r.room_id)) ||
    needs.some((n) => !saved.needs.some((v) => v.demand_id === n.demand_id));
  return {
    ...saved,
    groups,
    rooms,
    needs,
    ...(changed ? { confirmed: false, external_confirmed: false } : {}),
  };
}
const parseFeatures = (value: string) => [
  ...new Set(
    value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
  ),
];
const number = (value: string) => (value === "" ? null : Number(value));

export function RulesForm({
  data,
  context,
  busy,
  onSave,
  onDirty,
}: {
  data: PlanningData;
  context: PlanningData["contexts"][number];
  busy: boolean;
  onSave: (document: RulesDocument) => Promise<void>;
  onDirty: (value: boolean) => void;
}) {
  const [doc, setDoc] = useState<RulesDocument>(() =>
    initialRules(data, context),
  );
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", protect);
    return () => {
      window.removeEventListener("beforeunload", protect);
    };
  }, [dirty]);
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  const update = (changes: Partial<RulesDocument>, confirming = false) => {
    setDoc((d) => ({
      ...d,
      ...changes,
      ...(!confirming ? { confirmed: false, external_confirmed: false } : {}),
    }));
    setDirty(true);
  };
  const resourceOptions = (kind: "teacher" | "room" | "group") =>
    kind === "teacher"
      ? data.teachers
          .filter((t) => t.data_kind === context.data_kind)
          .map((t) => ({ id: t.id, label: t.name }))
      : kind === "room"
        ? data.rooms
            .filter((r) => r.data_kind === context.data_kind)
            .map((r) => ({ id: r.id, label: r.code }))
        : data.groups
            .filter(
              (g) =>
                g.data_kind === context.data_kind &&
                data.demands.some(
                  (d) => d.context_id === context.id && d.group_id === g.id,
                ),
            )
            .map((g) => ({ id: g.id, label: g.code }));
  function changeAvailability(index: number, changes: Partial<Availability>) {
    update({
      availability: doc.availability.map((v, i) =>
        i === index ? { ...v, ...changes } : v,
      ),
    });
  }
  function changeBusy(index: number, changes: Partial<BusyInterval>) {
    update({
      busy: doc.busy.map((v, i) => (i === index ? { ...v, ...changes } : v)),
    });
  }
  return (
    <form
      className="editor-panel planning-rules"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave({
          ...doc,
          rooms: doc.rooms.map((r) => ({
            ...r,
            features: parseFeatures(r.features.join(",")),
          })),
          needs: doc.needs.map((n) => ({
            ...n,
            features: parseFeatures(n.features.join(",")),
          })),
        })
          .then(() => setDirty(false))
          .catch(() => {});
      }}
    >
      <h2>
        {pm.conditions} · {pm.revision} {context.rules_revision}
      </h2>
      <p>{pm.ruleHint}</p>
      {dirty && (
        <p role="status" className="planning-warning">
          {pm.dirty}
        </p>
      )}
      <fieldset disabled={busy}>
        <details open>
          <summary>{pm.sizes}</summary>
          <div className="planning-input-grid">
            {doc.groups.map((g, i) => (
              <label key={g.group_id}>
                {data.groups.find((v) => v.id === g.group_id)?.code}
                <input
                  aria-label={`${pm.sizes}: ${data.groups.find((v) => v.id === g.group_id)?.code}`}
                  type="number"
                  min="1"
                  max="10000"
                  value={g.size ?? ""}
                  onChange={(e) =>
                    update({
                      groups: doc.groups.map((v, j) =>
                        j === i ? { ...v, size: number(e.target.value) } : v,
                      ),
                    })
                  }
                />
              </label>
            ))}
          </div>
        </details>
        <details open>
          <summary>{pm.capacity}</summary>
          <div className="planning-input-grid">
            {doc.rooms.map((r, i) => (
              <div key={r.room_id}>
                <label>
                  {pm.capacity}:{" "}
                  {data.rooms.find((v) => v.id === r.room_id)?.code}
                  <input
                    type="number"
                    min="1"
                    max="10000"
                    value={r.capacity ?? ""}
                    onChange={(e) =>
                      update({
                        rooms: doc.rooms.map((v, j) =>
                          j === i
                            ? { ...v, capacity: number(e.target.value) }
                            : v,
                        ),
                      })
                    }
                  />
                </label>
                <label>
                  {pm.features}:{" "}
                  {data.rooms.find((v) => v.id === r.room_id)?.code}
                  <input
                    value={r.features.join(",")}
                    onChange={(e) =>
                      update({
                        rooms: doc.rooms.map((v, j) =>
                          j === i
                            ? { ...v, features: e.target.value.split(",") }
                            : v,
                        ),
                      })
                    }
                  />
                </label>
              </div>
            ))}
          </div>
        </details>
        <details>
          <summary>{pm.needs}</summary>
          <p>{pm.needsHint}</p>
          <div className="planning-input-grid">
            {doc.needs.map((n, i) => (
              <label key={n.demand_id}>
                {data.demands.find((v) => v.id === n.demand_id)?.subject}
                <input
                  value={n.features.join(",")}
                  onChange={(e) =>
                    update({
                      needs: doc.needs.map((v, j) =>
                        j === i
                          ? { ...v, features: e.target.value.split(",") }
                          : v,
                      ),
                    })
                  }
                />
              </label>
            ))}
          </div>
        </details>
        <details open>
          <summary>{pm.availability}</summary>
          <p>{pm.availabilityHint}</p>
          {doc.availability.map((row, i) => (
            <fieldset className="planning-interval" key={i}>
              <legend>
                {pm.availability} {i + 1}
              </legend>
              <div className="planning-input-grid">
                <label>
                  {pm.resource}
                  <select
                    value={row.resource_type}
                    onChange={(e) =>
                      changeAvailability(i, {
                        resource_type: e.target.value as "teacher" | "room",
                        resource_id: "",
                      })
                    }
                  >
                    <option value="teacher">{pm.teacher}</option>
                    <option value="room">{pm.room}</option>
                  </select>
                </label>
                <label>
                  {row.resource_type === "teacher" ? pm.teacher : pm.room}
                  <select
                    required
                    value={row.resource_id}
                    onChange={(e) =>
                      changeAvailability(i, { resource_id: e.target.value })
                    }
                  >
                    <option value="">—</option>
                    {resourceOptions(row.resource_type).map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {pm.from}
                  <input
                    required
                    type="date"
                    value={row.start_date}
                    onChange={(e) =>
                      changeAvailability(i, { start_date: e.target.value })
                    }
                  />
                </label>
                <label>
                  {pm.to}
                  <input
                    required
                    type="date"
                    min={row.start_date}
                    value={row.end_date}
                    onChange={(e) =>
                      changeAvailability(i, { end_date: e.target.value })
                    }
                  />
                </label>
                <label>
                  {pm.timeFrom}
                  <input
                    required
                    type="time"
                    value={row.start}
                    onChange={(e) =>
                      changeAvailability(i, { start: e.target.value })
                    }
                  />
                </label>
                <label>
                  {pm.timeTo}
                  <input
                    required
                    type="time"
                    value={row.end}
                    onChange={(e) =>
                      changeAvailability(i, { end: e.target.value })
                    }
                  />
                </label>
              </div>
              <div className="planning-checks">
                {pm.weekdays.map((day, d) => (
                  <label key={d}>
                    <input
                      type="checkbox"
                      checked={row.weekdays.includes(d)}
                      onChange={(e) =>
                        changeAvailability(i, {
                          weekdays: e.target.checked
                            ? [...row.weekdays, d].sort()
                            : row.weekdays.filter((v) => v !== d),
                        })
                      }
                    />
                    {day}
                  </label>
                ))}
              </div>
              <button
                className="button button-quiet"
                type="button"
                onClick={() =>
                  update({
                    availability: doc.availability.filter((_, j) => j !== i),
                  })
                }
              >
                {pm.remove}
              </button>
            </fieldset>
          ))}
          <button
            className="button button-quiet"
            type="button"
            onClick={() =>
              update({
                availability: [
                  ...doc.availability,
                  {
                    resource_type: "teacher",
                    resource_id: "",
                    start_date: "",
                    end_date: "",
                    start: "",
                    end: "",
                    weekdays: [],
                  },
                ],
              })
            }
          >
            {pm.addAvailability}
          </button>
        </details>
        <details>
          <summary>{pm.busy}</summary>
          {doc.busy.map((row, i) => (
            <fieldset className="planning-interval" key={i}>
              <legend>
                {pm.busy} {i + 1}
              </legend>
              <div className="planning-input-grid">
                <label>
                  {pm.resource}
                  <select
                    value={row.resource_type}
                    onChange={(e) =>
                      changeBusy(i, {
                        resource_type: e.target
                          .value as BusyInterval["resource_type"],
                        resource_id: "",
                      })
                    }
                  >
                    <option value="teacher">{pm.teacher}</option>
                    <option value="room">{pm.room}</option>
                    <option value="group">{pm.group}</option>
                  </select>
                </label>
                <label>
                  {pm.resource}
                  <select
                    required
                    value={row.resource_id}
                    onChange={(e) =>
                      changeBusy(i, { resource_id: e.target.value })
                    }
                  >
                    <option value="">—</option>
                    {resourceOptions(row.resource_type).map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {pm.date}
                  <input
                    required
                    type="date"
                    value={row.date}
                    onChange={(e) => changeBusy(i, { date: e.target.value })}
                  />
                </label>
                <label>
                  {pm.timeFrom}
                  <input
                    required
                    type="time"
                    value={row.start}
                    onChange={(e) => changeBusy(i, { start: e.target.value })}
                  />
                </label>
                <label>
                  {pm.timeTo}
                  <input
                    required
                    type="time"
                    value={row.end}
                    onChange={(e) => changeBusy(i, { end: e.target.value })}
                  />
                </label>
                <label>
                  {pm.source}
                  <input
                    required
                    maxLength={300}
                    value={row.source}
                    onChange={(e) => changeBusy(i, { source: e.target.value })}
                  />
                </label>
              </div>
              <button
                className="button button-quiet"
                type="button"
                onClick={() =>
                  update({ busy: doc.busy.filter((_, j) => j !== i) })
                }
              >
                {pm.remove}
              </button>
            </fieldset>
          ))}
          <button
            className="button button-quiet"
            type="button"
            onClick={() =>
              update({
                busy: [
                  ...doc.busy,
                  {
                    resource_type: "teacher",
                    resource_id: "",
                    date: "",
                    start: "",
                    end: "",
                    source: "",
                  },
                ],
              })
            }
          >
            {pm.addBusy}
          </button>
        </details>
        <label>
          {pm.source}
          <input
            required={doc.confirmed}
            maxLength={300}
            value={doc.source}
            onChange={(e) => update({ source: e.target.value })}
          />
        </label>
        <label className="planning-checkbox">
          <input
            type="checkbox"
            checked={doc.external_confirmed}
            onChange={(e) =>
              update({ external_confirmed: e.target.checked }, true)
            }
          />
          {pm.external}
        </label>
        <label>
          {pm.externalSource}
          <input
            required={doc.external_confirmed}
            maxLength={300}
            value={doc.external_source}
            onChange={(e) => update({ external_source: e.target.value })}
          />
        </label>
        <label className="planning-checkbox">
          <input
            type="checkbox"
            checked={doc.confirmed}
            onChange={(e) => update({ confirmed: e.target.checked }, true)}
          />
          {pm.confirm}
        </label>
        <div className="editor-actions">
          <button className="button button-primary" type="submit">
            {pm.save}
          </button>
          <button
            className="button button-quiet"
            type="button"
            onClick={() => {
              setDoc(initialRules(data, context));
              setDirty(false);
            }}
          >
            {pm.discard}
          </button>
        </div>
      </fieldset>
    </form>
  );
}
