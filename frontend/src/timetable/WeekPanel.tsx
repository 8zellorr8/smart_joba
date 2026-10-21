import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ApiError } from "../api";
import { editorApi } from "../editor-api";
import type {
  DraftOccurrence,
  DraftView,
  EditorData,
  ScheduleDraft,
} from "../editor-api";
import { publicationApi } from "../publication-api";
import type { PublishedView, ReaderEvent } from "../publication-api";
import { demoName } from "../demo-labels";
import { Icon } from "../icons";
import { wb } from "../locales/workbench.kk";
import { StatusBadge } from "../ui/StatusBadge";
import {
  addDays,
  clock,
  dayLabel,
  lessonLanes,
  minutes,
  todayInZone,
  weekStart,
} from "./dates";
import { collectWeek } from "./pages";

export type WeekSource =
  | { kind: "draft"; value: ScheduleDraft; data: EditorData }
  | { kind: "publication"; value: PublishedView };
type Event = ReaderEvent | DraftOccurrence;
export function draftKey(value: ScheduleDraft): string {
  return `${value.id}:${value.revision}:${value.status}:${JSON.stringify(value.dependencies)}`;
}
function publicationKey(value: PublishedView): string {
  return `${value.publication_id}:${value.revision}`;
}
export function sourceZone(source: WeekSource): string {
  return source.kind === "publication"
    ? source.value.timezone
    : (source.data.calendars.find(
        (c) => c.context_id === source.value.context_id,
      )?.document.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
}
export function subjectTone(subject: string): number {
  return (
    Array.from(subject).reduce(
      (hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0,
      0,
    ) % 3
  );
}

export function WeekPanel({
  source,
  initialDate,
  initialFilter,
  onQuery,
  canEdit = false,
  onEdit,
  editor,
  onCloseEditor,
  onExpired,
  onStale,
  onDenied,
}: {
  source: WeekSource;
  initialDate?: string;
  canEdit?: boolean;
  initialFilter?: DraftView;
  onQuery?: (query: DraftView) => void;
  onEdit?: (event: DraftOccurrence) => void;
  editor?: ReactNode;
  onCloseEditor?: () => void;
  onExpired: () => void;
  onStale?: () => void;
  onDenied?: () => void;
}) {
  const zone = sourceZone(source);
  const today = todayInZone(zone);
  const [date, setDate] = useState(
    initialDate ?? (initialFilter?.start || today),
  );
  const [view, setView] = useState<"group" | "teacher" | "room">(
    initialFilter?.view ?? "group",
  );
  const [resource, setResource] = useState(initialFilter?.resource_id ?? "");
  const [records, setEvents] = useState<Event[]>([]);
  const [loadedKey, setLoadedKey] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [denied, setDenied] = useState(false);
  const [retry, setRetry] = useState(0);
  const latest = useRef({ source, onExpired, onStale, onDenied, onQuery });
  latest.current = { source, onExpired, onStale, onDenied, onQuery };
  const selectedButton = useRef<HTMLButtonElement | null>(null);
  const key =
    source.kind === "draft"
      ? draftKey(source.value)
      : publicationKey(source.value);
  const start = weekStart(date);
  const end = addDays(start, 6);
  const queryKey = `${key}:${start}:${end}:${view}:${resource}`;
  const events = loadedKey === queryKey ? records : [];
  useEffect(() => {
    let active = true;
    setBusy(true);
    setError("");
    setDenied(false);
    setEvents([]);
    setSelected(null);
    const captured = latest.current.source;
    latest.current.onQuery?.({
      start,
      end,
      view,
      resource_id: resource,
      offset: 0,
    });
    void collectWeek<Event>(
      async (offset) => {
        const filter = { start, end, view, resource_id: resource, offset };
        if (captured.kind === "draft") {
          const value = await editorApi.get(captured.value.id, filter);
          return {
            events: value.occurrences,
            offset: value.offset,
            total: value.total,
            limit: value.limit,
            key: draftKey(value),
          };
        }
        const value = await publicationApi.get(
          captured.value.publication_id,
          filter,
        );
        return {
          events: value.events,
          offset: value.offset,
          total: value.total,
          limit: value.limit,
          key: publicationKey(value),
        };
      },
      key,
      () => active,
    )
      .then((loaded) => {
        if (active && loaded) {
          setEvents(loaded);
          setLoadedKey(queryKey);
        }
      })
      .catch((problem) => {
        if (!active) return;
        setEvents([]);
        if (problem instanceof ApiError && problem.status === 401)
          latest.current.onExpired();
        if (problem instanceof ApiError && problem.status === 403) {
          setDenied(true);
          latest.current.onDenied?.();
        }
        if (problem instanceof ApiError && problem.code === "EDITOR_STALE") {
          setError(wb.stale);
          latest.current.onStale?.();
        } else setError(wb.error);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [key, start, end, view, resource, retry, queryKey]);
  const resources =
    source.kind === "publication"
      ? source.value.resources[view]
      : view === "room"
        ? source.data.rooms
            .filter((r) => r.data_kind === source.value.data_kind)
            .map((r) => ({ id: r.id, name: r.code }))
        : [
            ...new Map(
              source.data.assignments
                .filter((a) => a.context_id === source.value.context_id)
                .map((a) => [
                  view === "group" ? a.group_id : a.teacher_id,
                  {
                    id: view === "group" ? a.group_id : a.teacher_id,
                    name: view === "group" ? a.group : a.teacher,
                  },
                ]),
            ).values(),
          ];
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const labels = ["Дс", "Сс", "Ср", "Бс", "Жм", "Сб", "Жс"];
  const begin =
    Math.floor(
      events.reduce((min, e) => Math.min(min, minutes(e.start)), 8 * 60) / 60,
    ) * 60;
  const finish =
    Math.ceil(
      events.reduce((max, e) => Math.max(max, minutes(e.end)), 16 * 60) / 60,
    ) * 60;
  const hours = Array.from(
    { length: Math.ceil((finish - begin) / 60) + 1 },
    (_, i) => begin + i * 60,
  );
  const chosen = events.find((e) => e.id === selected);
  const name = (text: string) => demoName(text, source.value.data_kind);
  function close() {
    if (editor) onCloseEditor?.();
    else {
      setSelected(null);
      selectedButton.current?.focus();
    }
  }
  return (
    <section
      className="week-panel"
      aria-label={wb.weekly}
      aria-busy={busy}
      onKeyDown={(e) => {
        if (e.key === "Escape" && chosen) close();
      }}
    >
      {!denied && (
        <div className="week-toolbar">
          <label>
            {wb.group} / {wb.teacher} / {wb.room}
            <select
              aria-label="Кесте көрінісі"
              value={view}
              disabled={!!editor}
              onChange={(e) => {
                setView(e.target.value as typeof view);
                setResource("");
              }}
            >
              <option value="group">{wb.group}</option>
              <option value="teacher">{wb.teacher}</option>
              <option value="room">{wb.room}</option>
            </select>
          </label>
          <label>
            {view === "group"
              ? wb.group
              : view === "teacher"
                ? wb.teacher
                : wb.room}
            <select
              aria-label="Аптаның ресурсы"
              value={resource}
              disabled={!!editor}
              onChange={(e) => setResource(e.target.value)}
            >
              <option value="">{wb.all}</option>
              {resources.map((r) => (
                <option key={r.id} value={r.id}>
                  {name(r.name)}
                </option>
              ))}
            </select>
          </label>
          <div className="week-navigation">
            <button
              className="button button-quiet icon-button"
              aria-label={wb.previousWeek}
              disabled={!!editor}
              onClick={() => setDate(addDays(start, -7))}
            >
              <Icon name="left" />
            </button>
            <span className="week-range">
              {dayLabel(start)} — {dayLabel(end)} {end.slice(0, 4)}
            </span>
            <button
              className="button button-quiet icon-button"
              aria-label={wb.nextWeek}
              disabled={!!editor}
              onClick={() => setDate(addDays(start, 7))}
            >
              <Icon name="right" />
            </button>
          </div>
          <button
            className="button button-quiet"
            disabled={!!editor}
            onClick={() => setDate(today)}
          >
            {wb.today}
          </button>
          <label className="week-date">
            {wb.date}
            <input
              type="date"
              required
              value={date}
              disabled={!!editor}
              onChange={(e) => {
                if (e.target.value) setDate(e.target.value);
              }}
            />
          </label>
        </div>
      )}
      <div className="week-feedback" aria-live="polite">
        {busy && <p role="status">{wb.loading}</p>}
        {error && (
          <p role="alert" className="error-message">
            {error}{" "}
            <button
              className="button button-quiet"
              onClick={() => setRetry((v) => v + 1)}
            >
              {wb.retry}
            </button>
          </p>
        )}
        {!busy && !error && !events.length && <p>{wb.noWeekLessons}</p>}
      </div>
      {!denied && (
        <div className="week-workspace">
          <div
            className="week-scroll"
            role="region"
            aria-label={`${dayLabel(start)} — ${dayLabel(end)}`}
            tabIndex={0}
          >
            <div className="week-grid">
              <div className="week-grid-heading">
                <span>{wb.time}</span>
                {days.map((day, i) => (
                  <div key={day} className={day === today ? "is-today" : ""}>
                    <strong>{labels[i]}</strong>
                    <span>{dayLabel(day)}</span>
                  </div>
                ))}
              </div>
              <div
                className="week-grid-body"
                style={{ height: (finish - begin) * 1.1 }}
              >
                <div className="week-time-rail" aria-hidden="true">
                  {hours.map((hour) => (
                    <span key={hour} style={{ top: (hour - begin) * 1.1 }}>
                      {clock(hour)}
                    </span>
                  ))}
                </div>
                {days.map((day) => (
                  <section
                    className={`week-day ${day === today ? "is-today" : ""}`}
                    aria-label={dayLabel(day, true)}
                    key={day}
                  >
                    {hours.map((hour) => (
                      <div
                        className="week-hour-rule"
                        aria-hidden="true"
                        key={hour}
                        style={{ top: (hour - begin) * 1.1 }}
                      />
                    ))}
                    {lessonLanes(
                      events.filter((event) => event.date === day),
                    ).map(({ event, lane, lanes }) => (
                      <button
                        key={event.id}
                        className={`week-lesson subject-tone-${subjectTone(event.subject)} ${selected === event.id ? "is-selected" : ""} ${"cancelled" in event && event.cancelled ? "is-cancelled" : ""}`}
                        style={{
                          top: (minutes(event.start) - begin) * 1.1,
                          height: Math.max(
                            28,
                            (minutes(event.end) - minutes(event.start)) * 1.1 -
                              4,
                          ),
                          left: `calc(${(lane / lanes) * 100}% + 3px)`,
                          width: `calc(${100 / lanes}% - 6px)`,
                        }}
                        aria-pressed={selected === event.id}
                        disabled={busy || !!error || !!editor}
                        aria-label={`${dayLabel(event.date, true)} · ${event.start}–${event.end} · ${name(event.subject)} · ${name(event.group)}${"cancelled" in event && event.cancelled ? ` · ${wb.cancelled}` : ""}`}
                        onClick={(e) => {
                          selectedButton.current = e.currentTarget;
                          setSelected(event.id);
                        }}
                      >
                        <strong>{name(event.subject)}</strong>
                        <span>
                          {event.start}–{event.end}
                        </span>
                        <span>{name(event.room)}</span>
                        {"cancelled" in event && event.cancelled && (
                          <span>{wb.cancelled}</span>
                        )}
                      </button>
                    ))}
                  </section>
                ))}
              </div>
            </div>
          </div>
          <aside className="lesson-inspector" aria-label={wb.details}>
            <div className="inspector-heading">
              <h2>{wb.details}</h2>
              {chosen && (
                <button
                  className="button button-quiet icon-button"
                  aria-label={wb.close}
                  onClick={close}
                  disabled={busy}
                >
                  <Icon name="close" />
                </button>
              )}
            </div>
            {chosen ? (
              <>
                <h3>{name(chosen.subject)}</h3>
                <p>{dayLabel(chosen.date, true)}</p>
                <p className="inspector-time">
                  <Icon name="clock" size={18} />
                  {chosen.start}–{chosen.end}
                </p>
                <dl>
                  <div>
                    <dt>{wb.group}</dt>
                    <dd>{name(chosen.group)}</dd>
                  </div>
                  <div>
                    <dt>{wb.teacher}</dt>
                    <dd>{name(chosen.teacher)}</dd>
                  </div>
                  <div>
                    <dt>{wb.room}</dt>
                    <dd>{name(chosen.room)}</dd>
                  </div>
                </dl>
                <StatusBadge
                  tone={
                    "cancelled" in chosen && chosen.cancelled
                      ? "neutral"
                      : "info"
                  }
                >
                  {"cancelled" in chosen && chosen.cancelled
                    ? wb.cancelled
                    : wb.planned}
                </StatusBadge>
                {"pinned" in chosen && chosen.pinned && <p>{wb.pinned}</p>}
                {editor ||
                  (source.kind === "draft" &&
                  canEdit &&
                  source.value.status === "draft" &&
                  "series_id" in chosen ? (
                    <button
                      className="button button-primary inspector-edit"
                      disabled={busy || !!error}
                      onClick={() => onEdit?.(chosen)}
                    >
                      <Icon name="edit" size={18} />
                      {wb.edit}
                    </button>
                  ) : (
                    <p className="inspector-note">{wb.readOnly}</p>
                  ))}
              </>
            ) : (
              <p className="inspector-placeholder">{wb.selectLesson}</p>
            )}
          </aside>
        </div>
      )}
      {!busy && !error && (
        <p className="week-footnote">
          {wb.records}: {events.length} · {zone}
        </p>
      )}
    </section>
  );
}
