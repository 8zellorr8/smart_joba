import { useEffect, useRef, useState } from "react";
import { ApiError } from "./api";
import { journalApi } from "./journal-api";
import type { Journal, Roster, StudyProfile } from "./journal-api";
import { jm } from "./locales/journal.kk";
import { demoName } from "./demo-labels";
import { PageHeading } from "./ui/PageHeading";
import { Icon } from "./icons";
import "./journal.css";

export function JournalReadPage({
  scope,
  personal,
  onExpired,
}: {
  scope: string;
  personal: boolean;
  onExpired: () => void;
}) {
  const [catalog, setCatalog] = useState<Journal[] | null>(null);
  const [profile, setProfile] = useState<StudyProfile | null>(null);
  const [selected, setSelected] = useState<Journal | null>(null);
  const [date, setDate] = useState("");
  const [roster, setRoster] = useState<Roster | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [visit, setVisit] = useState(0);
  const epoch = useRef(0);
  const expired = useRef(onExpired);
  expired.current = onExpired;
  function failed(e: unknown) {
    if (e instanceof ApiError && e.status === 401) expired.current();
    const denied = e instanceof ApiError && e.status === 403;
    setError(denied ? jm.denied : jm.loadError);
    if (denied) {
      setCatalog(null);
      setProfile(null);
      setSelected(null);
    }
    setRoster(null);
  }
  useEffect(() => {
    const id = ++epoch.current;
    setCatalog(null);
    setProfile(null);
    setSelected(null);
    setRoster(null);
    setError("");
    const promise = personal
      ? journalApi.me(scope).then((data) => {
          if (epoch.current === id) setProfile(data);
        })
      : journalApi.journals(scope).then((data) => {
          if (epoch.current === id) setCatalog(data.journals);
        });
    void promise.catch((e: unknown) => {
      if (epoch.current === id) failed(e);
    });
    return () => {
      epoch.current++;
    };
  }, [scope, personal, visit]);
  async function showRoster() {
    if (!selected || !date) return;
    const id = ++epoch.current;
    setBusy(true);
    setError("");
    setRoster(null);
    try {
      const result = await journalApi.roster(scope, selected.id, date);
      if (epoch.current === id) setRoster(result);
    } catch (e) {
      if (epoch.current === id) failed(e);
    } finally {
      if (epoch.current === id) setBusy(false);
    }
  }
  const heading = (
    <PageHeading
      id="journal-read-title"
      eyebrow={jm.foundation}
      title={personal ? jm.profile : jm.title}
      description={personal ? jm.profileDescription : jm.next}
    />
  );
  return (
    <div className="journal-page">
      {heading}
      {error && (
        <div role="alert" className="journal-error">
          <p>{error}</p>
          <button
            className="button button-quiet"
            onClick={() => {
              setBusy(false);
              setVisit((v) => v + 1);
            }}
          >
            {jm.retry}
          </button>
        </div>
      )}
      {!error && !catalog && !profile && <p role="status">{jm.loading}</p>}
      {profile && (
        <section className="panel">
          <h2>{profile.student.display_name}</h2>
          <p>
            {profile.student.data_kind === "synthetic"
              ? jm.synthetic
              : jm.college}
          </p>
          <h3>{jm.memberships}</h3>
          {profile.memberships.length ? (
            <div className="journal-catalog">
              {profile.memberships.map((m) => (
                <article key={m.id}>
                  <strong>
                    {demoName(m.group, profile.student.data_kind)}
                  </strong>
                  <p>{m.academic_year}</p>
                  <p>
                    {m.start} — {m.end}
                  </p>
                </article>
              ))}
            </div>
          ) : (
            <p>{jm.noMemberships}</p>
          )}
          <p className="journal-note">{jm.intervalHelp}</p>
          <p className="journal-note">{jm.next}</p>
        </section>
      )}
      {catalog &&
        !selected &&
        (catalog.length ? (
          <div className="journal-read-grid">
            {catalog.map((j) => (
              <article className="panel" key={j.id}>
                <span className="journal-book">
                  <Icon name="book" size={25} />
                </span>
                <h2>{demoName(j.subject, j.data_kind)}</h2>
                <p>
                  {demoName(j.group, j.data_kind)} · {j.academic_year}
                </p>
                <p>
                  {j.semester} {jm.semester} ·{" "}
                  {j.data_kind === "synthetic" ? jm.synthetic : jm.college}
                </p>
                {j.periods?.map((p) => (
                  <p key={`${p.start}-${p.end}`}>
                    {p.start} — {p.end}
                  </p>
                ))}
                <button
                  className="button button-primary"
                  onClick={() => {
                    ++epoch.current;
                    setSelected(j);
                    setDate("");
                    setError("");
                    setRoster(null);
                  }}
                >
                  {jm.openRoster}
                </button>
              </article>
            ))}
          </div>
        ) : (
          !error && <p className="panel">{jm.emptyJournals}</p>
        ))}
      {selected && (
        <section className="panel">
          <button
            className="button button-quiet"
            onClick={() => {
              ++epoch.current;
              setSelected(null);
              setRoster(null);
              setBusy(false);
              setError("");
            }}
          >
            {jm.back}
          </button>
          <h2>
            {demoName(selected.subject, selected.data_kind)} ·{" "}
            {demoName(selected.group, selected.data_kind)}
          </h2>
          <p>{jm.preview}</p>
          <form
            className="journal-roster-date"
            onSubmit={(e) => {
              e.preventDefault();
              void showRoster();
            }}
          >
            <label>
              {jm.date}
              <input
                type="date"
                value={date}
                required
                onChange={(e) => {
                  ++epoch.current;
                  setDate(e.target.value);
                  setRoster(null);
                  setBusy(false);
                  setError("");
                }}
              />
            </label>
            <button className="button button-primary" disabled={busy}>
              {busy ? jm.loading : jm.show}
            </button>
          </form>
          {roster && (
            <>
              <h3>
                {jm.roster} · {roster.date}
              </h3>
              {roster.students.length ? (
                <ol className="journal-roster">
                  {roster.students.map((s) => (
                    <li key={s.id}>{s.display_name}</li>
                  ))}
                </ol>
              ) : (
                <p>{jm.noRoster}</p>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}
