import { useEffect, useState } from "react";
import { demoName } from "./demo-labels";
import type { FormEvent, ReactNode } from "react";
import { api, ApiError } from "./api";
import { calendarApi } from "./calendar-api";
import type {
  CalendarData,
  CalendarDay,
  CalendarDocument,
  CalendarHistory,
  CalendarProfile,
  DayKind,
  PlanPreview,
} from "./calendar-api";
import { cm, dayKinds, weekdays, calendarErrors } from "./locales/calendar.kk";
import { im } from "./locales/imports.kk";
import { PageHeading } from "./ui/PageHeading";
import { StatusBadge } from "./ui/StatusBadge";
import "./calendar.css";
const unitNames: Record<string, string> = {
  source_hour: im.source_hour,
  academic_hour: im.academic_hour,
  pair: im.pair,
  minute: im.minute,
};

export function emptyCalendar(): CalendarDocument {
  return {
    start: "",
    end: "",
    timezone: "Asia/Almaty",
    academic_minutes: 45,
    pair_minutes: 90,
    confirmed: false,
    source: "",
    units_confirmed: false,
    units_source: "",
    timezone_confirmed: false,
    timezone_source: "",
    periods: [],
    slots: [{ id: "slot-1", label: "1-сабақ", start: "09:00", end: "10:30" }],
    exceptions: [],
  };
}
function Field({
  label,
  id,
  children,
}: {
  label: string;
  id: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
    </div>
  );
}
const errorMessage = (error: unknown) =>
  error instanceof ApiError
    ? (calendarErrors[error.code] ?? cm.error)
    : cm.error;
function weekEnd(start: string, end: string) {
  const day = new Date(`${start}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 6);
  return day.toISOString().slice(0, 10) < end
    ? day.toISOString().slice(0, 10)
    : end;
}

export function CalendarPage({
  scope,
  csrfToken,
  canWrite,
  onExpired,
}: {
  scope: string;
  csrfToken: string;
  canWrite: boolean;
  onExpired: () => void;
}) {
  const [data, setData] = useState<CalendarData>({
    groups: [],
    profiles: [],
    demands: [],
  });
  const [profile, setProfile] = useState<CalendarProfile | null>(null);
  const [doc, setDoc] = useState<CalendarDocument>(emptyCalendar);
  const [year, setYear] = useState("2026-2027");
  const [kind, setKind] = useState<"college" | "synthetic">("synthetic");
  const [group, setGroup] = useState("");
  const [dirty, setDirty] = useState(false);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [csrf, setCsrf] = useState(csrfToken);
  const [days, setDays] = useState<CalendarDay[]>([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [calcStart, setCalcStart] = useState("");
  const [calcEnd, setCalcEnd] = useState("");
  const [slot, setSlot] = useState("");
  const [repeatDays, setRepeatDays] = useState([1]);
  const [cancelled, setCancelled] = useState("");
  const [demand, setDemand] = useState("");
  const [preview, setPreview] = useState<PlanPreview | null>(null);
  const [history, setHistory] = useState<CalendarHistory[]>([]);
  const [historical, setHistorical] = useState<CalendarHistory | null>(null);

  useEffect(() => setCsrf(csrfToken), [csrfToken]);
  useEffect(() => {
    let active = true;
    void calendarApi
      .data(scope)
      .then((loaded) => {
        if (!active) return;
        setData(loaded);
        if (loaded.profiles.length) selectProfile(loaded.profiles[0]);
        else
          setGroup(
            loaded.groups.find((g) => g.data_kind === "synthetic")?.id ?? "",
          );
      })
      .catch((problem) => {
        if (active) fail(problem);
      });
    return () => {
      active = false;
    };
  }, [scope]);
  useEffect(() => {
    if (!profile) return;
    let active = true;
    const check = () => {
      if (document.visibilityState !== "visible") return;
      void calendarApi
        .get(profile.id)
        .then((fresh) => {
          if (
            active &&
            (fresh.revision !== profile.revision ||
              fresh.context_revision !== profile.context_revision)
          ) {
            setStale(true);
            setPreview(null);
            setDays([]);
            setNotice("");
          }
        })
        .catch((problem) => {
          if (active && problem instanceof ApiError && problem.status === 401)
            onExpired();
        });
    };
    document.addEventListener("visibilitychange", check);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", check);
    };
  }, [profile, onExpired]);

  function fail(problem: unknown) {
    if (problem instanceof ApiError && problem.status === 401) onExpired();
    else {
      setError(errorMessage(problem));
      if (problem instanceof ApiError && problem.code === "CALENDAR_STALE") {
        setStale(true);
        setPreview(null);
        setDays([]);
      }
    }
  }
  async function act(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (problem) {
      fail(problem);
    } finally {
      setBusy(false);
    }
  }
  async function mutate<T>(action: (token: string) => Promise<T>): Promise<T> {
    try {
      return await action(csrf);
    } catch (problem) {
      if (!(problem instanceof ApiError) || problem.code !== "CSRF_INVALID")
        throw problem;
      const fresh = await api.session();
      if (!fresh.user) throw new ApiError(401, "AUTH_REQUIRED");
      setCsrf(fresh.csrf_token);
      return action(fresh.csrf_token);
    }
  }
  function selectProfile(value: CalendarProfile) {
    setProfile(value);
    setDoc(structuredClone(value.document));
    setYear(value.academic_year);
    setKind(value.data_kind);
    setGroup(value.group_id);
    setDirty(false);
    setStale(false);
    setPreview(null);
    setDays([]);
    setHistory([]);
    setHistorical(null);
    setError("");
    setNotice("");
    setFrom(value.document.start);
    setTo(weekEnd(value.document.start, value.document.end));
    setCalcStart(value.document.start);
    setCalcEnd(value.document.end);
    setSlot(value.document.slots[0]?.id ?? "");
    setCancelled("");
    setDemand("");
  }
  function change<K extends keyof CalendarDocument>(
    key: K,
    value: CalendarDocument[K],
  ) {
    setDoc((previous) => ({
      ...previous,
      ...(["academic_minutes", "pair_minutes"].includes(key)
        ? { units_confirmed: false }
        : {}),
      ...(key === "timezone" ? { timezone_confirmed: false } : {}),
      ...(["start", "end", "periods", "slots", "exceptions"].includes(key)
        ? { confirmed: false }
        : {}),
      [key]: value,
    }));
    setDirty(true);
    setPreview(null);
    setDays([]);
    setNotice("");
  }
  function freshCalendar() {
    setProfile(null);
    setDoc(emptyCalendar());
    setDirty(false);
    setStale(false);
    setPreview(null);
    setDays([]);
    setHistory([]);
    setHistorical(null);
    setError("");
    setNotice("");
    setGroup(data.groups.find((g) => g.data_kind === kind)?.id ?? "");
  }
  function save(event: FormEvent) {
    event.preventDefault();
    void act(async () => {
      const saved = profile
        ? await mutate((token) => calendarApi.update(profile, doc, token))
        : await mutate((token) =>
            calendarApi.create(
              scope,
              {
                academic_year: year,
                data_kind: kind,
                group_id: group,
                document: doc,
              },
              token,
            ),
          );
      selectProfile(saved);
      setData((previous) => ({
        ...previous,
        profiles: [
          saved,
          ...previous.profiles.filter((p) => p.id !== saved.id),
        ],
      }));
      setNotice(cm.saved);
    });
  }
  const editable = canWrite && !busy;
  const canCalculate = !!profile && !dirty && !stale && !busy;
  const demandOptions = data.demands.filter(
    (d) =>
      d.context_id === profile?.context_id && d.group_id === profile?.group_id,
  );
  return (
    <section
      className="calendar-page"
      aria-labelledby="calendar-title"
      aria-busy={busy}
    >
      <PageHeading
        id="calendar-title"
        eyebrow={cm.eyebrow}
        title={cm.title}
        description={cm.intro}
      />
      <div aria-live="polite">
        {error && (
          <p role="alert" className="error-message calendar-notice">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="notice calendar-notice">
            {notice}
          </p>
        )}
      </div>
      {stale && <p className="notice calendar-notice">{cm.stale}</p>}
      {!canWrite && <p className="notice calendar-notice">{cm.readonly}</p>}
      <div className="calendar-toolbar">
        <Field label={cm.profiles} id="calendar-profile">
          <select
            id="calendar-profile"
            disabled={busy}
            value={profile?.id ?? ""}
            onChange={(e) => {
              const item = data.profiles.find((p) => p.id === e.target.value);
              if (item)
                void act(async () =>
                  selectProfile(await calendarApi.get(item.id)),
                );
            }}
          >
            <option value="">{cm.noProfile}</option>
            {data.profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {demoName(p.group_code, p.data_kind)} · {p.academic_year} ·{" "}
                {p.data_kind === "synthetic" ? cm.synthetic : cm.college}
              </option>
            ))}
          </select>
        </Field>
        {canWrite && (
          <button
            type="button"
            className="button button-quiet"
            disabled={busy}
            onClick={freshCalendar}
          >
            {cm.create}
          </button>
        )}
        {profile && (
          <button
            type="button"
            className="button button-quiet"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const fresh = await calendarApi.get(profile.id);
                const loaded = await calendarApi.data(scope);
                setData(loaded);
                selectProfile(fresh);
              })
            }
          >
            {cm.reload}
          </button>
        )}
      </div>
      {(profile || canWrite) && (
        <>
          <form onSubmit={save} className="calendar-panel">
            <h2>{cm.settings}</h2>
            <p className="calendar-help">{cm.assumption}</p>
            <div className="calendar-grid">
              <Field label={cm.year} id="calendar-year">
                <input
                  id="calendar-year"
                  value={year}
                  required
                  pattern="20[0-9]{2}-20[0-9]{2}"
                  disabled={!editable || !!profile}
                  onChange={(e) => setYear(e.target.value)}
                />
              </Field>
              <Field label={cm.kind} id="calendar-kind">
                <select
                  id="calendar-kind"
                  value={kind}
                  disabled={!editable || !!profile}
                  onChange={(e) => {
                    const next = e.target.value as typeof kind;
                    setKind(next);
                    setGroup(
                      data.groups.find((g) => g.data_kind === next)?.id ?? "",
                    );
                  }}
                >
                  <option value="synthetic">{cm.synthetic}</option>
                  <option value="college">{cm.college}</option>
                </select>
              </Field>
              <Field label={cm.group} id="calendar-group">
                <select
                  id="calendar-group"
                  value={group}
                  required
                  disabled={!editable || !!profile}
                  onChange={(e) => setGroup(e.target.value)}
                >
                  <option value="">—</option>
                  {data.groups
                    .filter((g) => g.data_kind === kind)
                    .map((g) => (
                      <option value={g.id} key={g.id}>
                        {demoName(g.code, g.data_kind)}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label={cm.start} id="calendar-start">
                <input
                  id="calendar-start"
                  type="date"
                  required
                  value={doc.start}
                  disabled={!editable}
                  onChange={(e) => change("start", e.target.value)}
                />
              </Field>
              <Field label={cm.end} id="calendar-end">
                <input
                  id="calendar-end"
                  type="date"
                  required
                  value={doc.end}
                  disabled={!editable}
                  onChange={(e) => change("end", e.target.value)}
                />
              </Field>
              <Field label={cm.timezone} id="calendar-timezone">
                <input
                  id="calendar-timezone"
                  value={doc.timezone}
                  required
                  maxLength={80}
                  disabled={!editable}
                  onChange={(e) => change("timezone", e.target.value)}
                />
              </Field>
              <Field label={cm.academic} id="academic-minutes">
                <input
                  id="academic-minutes"
                  type="number"
                  min="1"
                  max="240"
                  required
                  value={doc.academic_minutes}
                  disabled={!editable}
                  onChange={(e) =>
                    change("academic_minutes", Number(e.target.value))
                  }
                />
              </Field>
              <Field label={cm.pair} id="pair-minutes">
                <input
                  id="pair-minutes"
                  type="number"
                  min="1"
                  max="480"
                  required
                  value={doc.pair_minutes}
                  disabled={!editable}
                  onChange={(e) =>
                    change("pair_minutes", Number(e.target.value))
                  }
                />
              </Field>
            </div>
            {!group && <p className="calendar-help">{cm.noGroup}</p>}
            <h3>{cm.periods}</h3>
            {doc.periods.map((period, index) => (
              <fieldset className="calendar-row" key={index}>
                <legend>
                  {cm.periods} · {index + 1}
                </legend>
                <div className="calendar-grid">
                  <Field label={cm.start} id={`period-start-${index}`}>
                    <input
                      id={`period-start-${index}`}
                      type="date"
                      required
                      value={period.start}
                      disabled={!editable}
                      onChange={(e) =>
                        change(
                          "periods",
                          doc.periods.map((p, i) =>
                            i === index ? { ...p, start: e.target.value } : p,
                          ),
                        )
                      }
                    />
                  </Field>
                  <Field label={cm.end} id={`period-end-${index}`}>
                    <input
                      id={`period-end-${index}`}
                      type="date"
                      required
                      value={period.end}
                      disabled={!editable}
                      onChange={(e) =>
                        change(
                          "periods",
                          doc.periods.map((p, i) =>
                            i === index ? { ...p, end: e.target.value } : p,
                          ),
                        )
                      }
                    />
                  </Field>
                  <Field label={cm.periodKind} id={`period-kind-${index}`}>
                    <select
                      id={`period-kind-${index}`}
                      value={period.kind}
                      disabled={!editable}
                      onChange={(e) =>
                        change(
                          "periods",
                          doc.periods.map((p, i) =>
                            i === index
                              ? { ...p, kind: e.target.value as DayKind }
                              : p,
                          ),
                        )
                      }
                    >
                      {Object.entries(dayKinds).map(([key, value]) => (
                        <option key={key} value={key}>
                          {value}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={cm.semester} id={`period-semester-${index}`}>
                    <input
                      id={`period-semester-${index}`}
                      type="number"
                      min="1"
                      max="20"
                      value={period.semester ?? ""}
                      disabled={!editable}
                      onChange={(e) =>
                        change(
                          "periods",
                          doc.periods.map((p, i) =>
                            i === index
                              ? {
                                  ...p,
                                  semester: e.target.value
                                    ? Number(e.target.value)
                                    : null,
                                }
                              : p,
                          ),
                        )
                      }
                    />
                  </Field>
                  <Field label={cm.periodName} id={`period-label-${index}`}>
                    <input
                      id={`period-label-${index}`}
                      maxLength={160}
                      value={period.label}
                      disabled={!editable}
                      onChange={(e) =>
                        change(
                          "periods",
                          doc.periods.map((p, i) =>
                            i === index ? { ...p, label: e.target.value } : p,
                          ),
                        )
                      }
                    />
                  </Field>
                </div>
                {canWrite && (
                  <button
                    className="calendar-text-button"
                    type="button"
                    disabled={!editable}
                    onClick={() =>
                      change(
                        "periods",
                        doc.periods.filter((_, i) => i !== index),
                      )
                    }
                  >
                    {cm.remove} · {index + 1}
                  </button>
                )}
              </fieldset>
            ))}
            {canWrite && (
              <button
                className="button button-quiet"
                type="button"
                disabled={!editable || doc.periods.length >= 150}
                onClick={() =>
                  change("periods", [
                    ...doc.periods,
                    {
                      start: doc.start,
                      end: doc.end,
                      kind: "unknown",
                      label: "",
                    },
                  ])
                }
              >
                {cm.addPeriod}
              </button>
            )}
            <h3>{cm.slots}</h3>
            {doc.slots.map((item, index) => (
              <fieldset className="calendar-row" key={item.id}>
                <legend>
                  {cm.slots} · {index + 1}
                </legend>
                <div className="calendar-grid">
                  <Field label={cm.slotName} id={`slot-label-${index}`}>
                    <input
                      id={`slot-label-${index}`}
                      required
                      maxLength={80}
                      value={item.label}
                      disabled={!editable}
                      onChange={(e) =>
                        change(
                          "slots",
                          doc.slots.map((s, i) =>
                            i === index ? { ...s, label: e.target.value } : s,
                          ),
                        )
                      }
                    />
                  </Field>
                  <Field label={cm.timeStart} id={`slot-start-${index}`}>
                    <input
                      id={`slot-start-${index}`}
                      type="time"
                      required
                      value={item.start}
                      disabled={!editable}
                      onChange={(e) =>
                        change(
                          "slots",
                          doc.slots.map((s, i) =>
                            i === index ? { ...s, start: e.target.value } : s,
                          ),
                        )
                      }
                    />
                  </Field>
                  <Field label={cm.timeEnd} id={`slot-end-${index}`}>
                    <input
                      id={`slot-end-${index}`}
                      type="time"
                      required
                      value={item.end}
                      disabled={!editable}
                      onChange={(e) =>
                        change(
                          "slots",
                          doc.slots.map((s, i) =>
                            i === index ? { ...s, end: e.target.value } : s,
                          ),
                        )
                      }
                    />
                  </Field>
                </div>
                {canWrite && (
                  <button
                    className="calendar-text-button"
                    type="button"
                    disabled={!editable}
                    onClick={() =>
                      change(
                        "slots",
                        doc.slots.filter((_, i) => i !== index),
                      )
                    }
                  >
                    {cm.remove} · {index + 1}
                  </button>
                )}
              </fieldset>
            ))}
            {canWrite && (
              <button
                type="button"
                className="button button-quiet"
                disabled={!editable || doc.slots.length >= 20}
                onClick={() =>
                  change("slots", [
                    ...doc.slots,
                    {
                      id: crypto.randomUUID(),
                      label: `${doc.slots.length + 1}-сабақ`,
                      start: "",
                      end: "",
                    },
                  ])
                }
              >
                {cm.addSlot}
              </button>
            )}
            <h3>{cm.exceptions}</h3>
            {doc.exceptions.map((item, index) => (
              <fieldset className="calendar-row" key={index}>
                <legend>
                  {cm.exceptions} · {index + 1}
                </legend>
                <div className="calendar-grid">
                  <Field
                    label={cm.exceptionDate}
                    id={`exception-date-${index}`}
                  >
                    <input
                      id={`exception-date-${index}`}
                      type="date"
                      required
                      value={item.date}
                      disabled={!editable}
                      onChange={(e) =>
                        change(
                          "exceptions",
                          doc.exceptions.map((x, i) =>
                            i === index ? { ...x, date: e.target.value } : x,
                          ),
                        )
                      }
                    />
                  </Field>
                  <Field
                    label={cm.exceptionReason}
                    id={`exception-reason-${index}`}
                  >
                    <input
                      id={`exception-reason-${index}`}
                      required
                      maxLength={300}
                      value={item.reason}
                      disabled={!editable}
                      onChange={(e) =>
                        change(
                          "exceptions",
                          doc.exceptions.map((x, i) =>
                            i === index ? { ...x, reason: e.target.value } : x,
                          ),
                        )
                      }
                    />
                  </Field>
                  <label className="calendar-check">
                    <input
                      type="checkbox"
                      checked={item.allowed}
                      disabled={!editable}
                      onChange={(e) =>
                        change(
                          "exceptions",
                          doc.exceptions.map((x, i) =>
                            i === index
                              ? { ...x, allowed: e.target.checked }
                              : x,
                          ),
                        )
                      }
                    />
                    {cm.allow}
                  </label>
                </div>
                {canWrite && (
                  <button
                    type="button"
                    className="calendar-text-button"
                    disabled={!editable}
                    onClick={() =>
                      change(
                        "exceptions",
                        doc.exceptions.filter((_, i) => i !== index),
                      )
                    }
                  >
                    {cm.remove} · {index + 1}
                  </button>
                )}
              </fieldset>
            ))}
            {canWrite && (
              <button
                type="button"
                className="button button-quiet"
                disabled={!editable || doc.exceptions.length >= 100}
                onClick={() =>
                  change("exceptions", [
                    ...doc.exceptions,
                    { date: doc.start, allowed: false, reason: "" },
                  ])
                }
              >
                {cm.addException}
              </button>
            )}
            <div className="calendar-confirmations">
              {(
                [
                  ["confirmed", "source", cm.confirmed, cm.source],
                  [
                    "units_confirmed",
                    "units_source",
                    cm.unitsConfirmed,
                    cm.unitsSource,
                  ],
                  [
                    "timezone_confirmed",
                    "timezone_source",
                    cm.timezoneConfirmed,
                    cm.timezoneSource,
                  ],
                ] as const
              ).map(([flag, source, label, sourceLabel]) => (
                <div key={flag}>
                  <Field label={sourceLabel} id={source}>
                    <input
                      id={source}
                      maxLength={300}
                      required={doc[flag]}
                      value={doc[source]}
                      disabled={!editable}
                      onChange={(e) => change(source, e.target.value)}
                    />
                  </Field>
                  <label className="calendar-check">
                    <input
                      type="checkbox"
                      checked={doc[flag]}
                      disabled={!editable}
                      onChange={(e) => change(flag, e.target.checked)}
                    />
                    {label}
                  </label>
                </div>
              ))}
            </div>
            <div className="calendar-actions">
              {canWrite && (
                <button
                  className="button button-primary"
                  type="submit"
                  disabled={!editable || !group || (profile !== null && !dirty)}
                >
                  {busy ? cm.busy : cm.save}
                </button>
              )}
              {profile && (
                <span>
                  {cm.revision}: {profile.revision}
                </span>
              )}
              {dirty && <span role="status">{cm.dirty}</span>}
            </div>
          </form>
          {profile && (
            <>
              <section className="calendar-panel">
                <h2>{cm.datesTitle}</h2>
                <p className="calendar-help">{cm.datesHint}</p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act(async () => {
                      const loaded = await calendarApi.dates(
                        profile.id,
                        from,
                        to,
                      );
                      if (
                        loaded.revision !== profile.revision ||
                        loaded.context_revision !== profile.context_revision
                      )
                        throw new ApiError(409, "CALENDAR_STALE");
                      setDays(loaded.dates);
                    });
                  }}
                >
                  <div className="calendar-grid">
                    <Field label={cm.start} id="dates-start">
                      <input
                        id="dates-start"
                        type="date"
                        required
                        value={from}
                        onChange={(e) => {
                          setFrom(e.target.value);
                          setDays([]);
                        }}
                      />
                    </Field>
                    <Field label={cm.end} id="dates-end">
                      <input
                        id="dates-end"
                        type="date"
                        required
                        value={to}
                        onChange={(e) => {
                          setTo(e.target.value);
                          setDays([]);
                        }}
                      />
                    </Field>
                  </div>
                  <button
                    className="button button-quiet"
                    disabled={!canCalculate}
                  >
                    {cm.showDates}
                  </button>
                </form>
                {days.length > 0 && (
                  <div
                    className="calendar-table-wrap"
                    role="region"
                    aria-label={cm.datesTitle}
                    tabIndex={0}
                  >
                    <table>
                      <caption>
                        {from} — {to}
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">{cm.date}</th>
                          <th scope="col">{cm.day}</th>
                          <th scope="col">{cm.periodKind}</th>
                          <th scope="col">{cm.status}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {days.map((day) => (
                          <tr key={day.date}>
                            <td>{day.date}</td>
                            <td>{weekdays[day.weekday]}</td>
                            <td>{dayKinds[day.kind]}</td>
                            <td>
                              <StatusBadge
                                tone={day.allowed ? "success" : "warning"}
                              >
                                {day.allowed ? cm.allowed : cm.blocked}
                              </StatusBadge>
                              {day.exception && (
                                <small>{day.exception.reason}</small>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
              <section className="calendar-panel">
                <h2>{cm.hoursTitle}</h2>
                <p className="calendar-help">{cm.hoursHint}</p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    setPreview(null);
                    void act(async () =>
                      setPreview(
                        await mutate((token) =>
                          calendarApi.preview(
                            profile,
                            [
                              {
                                id: "preview-1",
                                start: calcStart,
                                end: calcEnd,
                                slot_id: slot,
                                weekdays: repeatDays,
                                dates: [],
                                cancelled_dates: cancelled
                                  .split(/[,\s]+/)
                                  .filter(Boolean),
                              },
                            ],
                            demand,
                            token,
                          ),
                        ),
                      ),
                    );
                  }}
                >
                  <div className="calendar-grid">
                    <Field label={cm.calcStart} id="calc-start">
                      <input
                        id="calc-start"
                        type="date"
                        required
                        value={calcStart}
                        onChange={(e) => {
                          setCalcStart(e.target.value);
                          setPreview(null);
                        }}
                      />
                    </Field>
                    <Field label={cm.calcEnd} id="calc-end">
                      <input
                        id="calc-end"
                        type="date"
                        required
                        value={calcEnd}
                        onChange={(e) => {
                          setCalcEnd(e.target.value);
                          setPreview(null);
                        }}
                      />
                    </Field>
                    <Field label={cm.slot} id="calc-slot">
                      <select
                        id="calc-slot"
                        required
                        value={slot}
                        onChange={(e) => {
                          setSlot(e.target.value);
                          setPreview(null);
                        }}
                      >
                        {doc.slots.map((s) => (
                          <option key={s.id} value={s.id}>
                            {demoName(s.label, kind)} · {s.start}–{s.end}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <fieldset className="calendar-weekdays">
                    <legend>{cm.weekdays}</legend>
                    {weekdays.map((label, index) => (
                      <label className="calendar-check" key={label}>
                        <input
                          type="checkbox"
                          checked={repeatDays.includes(index)}
                          onChange={(e) => {
                            setRepeatDays(
                              e.target.checked
                                ? [...repeatDays, index]
                                : repeatDays.filter((d) => d !== index),
                            );
                            setPreview(null);
                          }}
                        />
                        {label}
                      </label>
                    ))}
                  </fieldset>
                  <div className="calendar-grid">
                    <Field label={cm.cancelled} id="calc-cancelled">
                      <input
                        id="calc-cancelled"
                        value={cancelled}
                        onChange={(e) => {
                          setCancelled(e.target.value);
                          setPreview(null);
                        }}
                        aria-describedby="cancel-hint"
                      />
                      <small id="cancel-hint">{cm.cancelledHint}</small>
                    </Field>
                    <Field label={cm.demand} id="calc-demand">
                      <select
                        id="calc-demand"
                        value={demand}
                        onChange={(e) => {
                          setDemand(e.target.value);
                          setPreview(null);
                        }}
                      >
                        <option value="">{cm.noDemand}</option>
                        {demandOptions.map((d) => (
                          <option key={d.id} value={d.id}>
                            {demoName(d.subject, kind)} · {d.semester ?? "?"} ·{" "}
                            {d.semester_amount ?? "?"}{" "}
                            {unitNames[d.unit] ?? cm.unknown}
                            {d.confirmed ? "" : " · ?"}
                          </option>
                        ))}
                      </select>
                      <small>{cm.noDemandHint}</small>
                    </Field>
                  </div>
                  <button
                    className="button button-primary"
                    disabled={!canCalculate || !repeatDays.length || !slot}
                  >
                    {cm.calculate}
                  </button>
                </form>
                {preview && (
                  <div className="calendar-result" aria-live="polite">
                    {!preview.valid && (
                      <p role="alert" className="error-message">
                        {cm.resultInvalid}
                      </p>
                    )}
                    {preview.assumptions.length > 0 && (
                      <p className="notice">{cm.resultAssumed}</p>
                    )}
                    <dl className="calendar-metrics">
                      <div>
                        <dt>{cm.planned}</dt>
                        <dd>{preview.planned_academic_hours}</dd>
                      </div>
                      <div>
                        <dt>{cm.required}</dt>
                        <dd>{preview.required_academic_hours ?? "—"}</dd>
                      </div>
                      <div>
                        <dt>{cm.remaining}</dt>
                        <dd>{preview.remaining_academic_hours ?? "—"}</dd>
                      </div>
                      <div>
                        <dt>{cm.minutes}</dt>
                        <dd>{preview.planned_minutes}</dd>
                      </div>
                    </dl>
                    <p>
                      {cm.active}: {preview.active_count} · {cm.cancelledCount}:{" "}
                      {preview.cancelled_count} · {cm.blockedCount}:{" "}
                      {preview.blocked_count} · {cm.pairs}:{" "}
                      {preview.planned_pairs}
                    </p>
                    {preview.comparison_issue && (
                      <p className="notice">
                        {calendarErrors[preview.comparison_issue] ??
                          cm.unresolvedDemand}
                      </p>
                    )}
                    <p className="calendar-help">
                      {cm.exact}: {preview.planned_academic_exact} ·{" "}
                      {cm.noActual}
                    </p>
                    {preview.demand && (
                      <p className="calendar-help">
                        {cm.sourceAmount}:{" "}
                        {preview.demand.semester_amount ?? "—"} ·{" "}
                        {cm.weeklyAmount}: {preview.demand.weekly_amount ?? "—"}{" "}
                        · {cm.unit}:{" "}
                        {unitNames[preview.demand.unit] ?? cm.unknown} ·{" "}
                        {preview.demand.source_coordinate}
                        {!preview.demand.confirmed &&
                          ` · ${cm.unresolvedDemand}`}
                      </p>
                    )}
                    <div
                      className="calendar-table-wrap"
                      role="region"
                      aria-label={cm.hoursTitle}
                      tabIndex={0}
                    >
                      <table>
                        <caption>{cm.hoursTitle}</caption>
                        <thead>
                          <tr>
                            <th scope="col">{cm.date}</th>
                            <th scope="col">{cm.slots}</th>
                            <th scope="col">{cm.status}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {preview.occurrences.map((o) => (
                            <tr key={`${o.pattern_id}-${o.date}`}>
                              <td>{o.date}</td>
                              <td>
                                {o.start}–{o.end}
                              </td>
                              <td>
                                <StatusBadge
                                  tone={
                                    o.status === "planned"
                                      ? "info"
                                      : o.status === "cancelled"
                                        ? "neutral"
                                        : "warning"
                                  }
                                >
                                  {cm.planStatus[o.status]}
                                </StatusBadge>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </section>
              <section className="calendar-panel">
                <h2>{cm.history}</h2>
                <button
                  className="button button-quiet"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      setHistory(await calendarApi.history(profile.id));
                      setHistorical(null);
                    })
                  }
                >
                  {cm.historyShow}
                </button>
                {history.length > 0 && (
                  <ol className="calendar-history">
                    {history.map((r) => (
                      <li key={r.id}>
                        {cm.revision} {r.revision} · {r.created_at.slice(0, 10)}{" "}
                        <button
                          type="button"
                          className="calendar-text-button"
                          onClick={() => setHistorical(r)}
                        >
                          {cm.historyView} · {r.revision}
                        </button>
                      </li>
                    ))}
                  </ol>
                )}
                {historical && (
                  <div className="calendar-history-detail">
                    <strong>
                      {cm.revision} {historical.revision}
                    </strong>
                    <p>
                      {historical.document.start} — {historical.document.end} ·{" "}
                      {historical.document.timezone} ·{" "}
                      {historical.document.academic_minutes}/
                      {historical.document.pair_minutes} мин.
                    </p>
                    <p>{historical.document.source || cm.unknown}</p>
                    {historical.document.periods.map((p, i) => (
                      <p key={i}>
                        {p.start} — {p.end}: {dayKinds[p.kind]} ·{" "}
                        {demoName(p.label, kind)}
                      </p>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
        </>
      )}
    </section>
  );
}
