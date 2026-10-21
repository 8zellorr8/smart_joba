import { useEffect, useRef, useState } from "react";
import { ApiError } from "./api";
import { demoName } from "./demo-labels";
import { publicationApi } from "./publication-api";
import type {
  PublicationFilter,
  PublishedSummary,
  PublishedView,
} from "./publication-api";
import { publicationMessages, vm } from "./locales/publication.kk";
import { pm } from "./locales/planning.kk";
import "./editor.css";
import "./planning.css";
import "./publication.css";
import { PageHeading } from "./ui/PageHeading";
import { StatusBadge } from "./ui/StatusBadge";

const emptyFilter = (): PublicationFilter => ({
  start: "",
  end: "",
  view: "group",
  resource_id: "",
  offset: 0,
});
export function PublicationsPage({
  scope,
  onExpired,
}: {
  scope: string;
  onExpired: () => void;
}) {
  const [items, setItems] = useState<PublishedSummary[]>([]);
  const [value, setValue] = useState<PublishedView | null>(null);
  const [filter, setFilter] = useState(emptyFilter);
  const [applied, setApplied] = useState(emptyFilter);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const expired = useRef(onExpired);
  expired.current = onExpired;
  function fail(problem: unknown) {
    if (
      problem instanceof ApiError &&
      (problem.status === 401 || problem.status === 403)
    ) {
      setValue(null);
      setItems([]);
      if (problem.status === 401) {
        expired.current();
        return;
      }
    }
    setError(
      problem instanceof ApiError
        ? (publicationMessages[problem.code] ??
            (problem.status === 0 ? pm.connection : vm.error))
        : vm.error,
    );
  }
  async function load(id: string, next: PublicationFilter) {
    const result = await publicationApi.get(id, next);
    setValue(result);
    setApplied(next);
  }
  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (problem) {
      fail(problem);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    let alive = true;
    setBusy(true);
    setValue(null);
    setItems([]);
    setError("");
    publicationApi
      .list(scope)
      .then(async (list) => {
        if (!alive) return;
        setItems(list);
        if (list.length) {
          const result = await publicationApi.get(
            list[0].publication_id,
            emptyFilter(),
          );
          if (alive) {
            setValue(result);
            setFilter(emptyFilter());
            setApplied(emptyFilter());
          }
        }
      })
      .catch((problem) => {
        if (alive) fail(problem);
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [scope]);
  return (
    <section
      className="version-page"
      aria-labelledby="publications-title"
      aria-busy={busy}
    >
      <PageHeading
        id="publications-title"
        eyebrow={vm.current}
        title={vm.publication}
        description={vm.publicIntro}
      />
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
      <section className="editor-panel">
        <label>
          {vm.publication}
          <select
            value={value?.publication_id ?? ""}
            disabled={busy || !items.length}
            onChange={(e) => {
              const id = e.target.value;
              setValue(null);
              setFilter(emptyFilter());
              void act(async () => load(id, emptyFilter()));
            }}
          >
            <option value="" disabled>
              —
            </option>
            {items.map((item) => (
              <option key={item.publication_id} value={item.publication_id}>
                {item.academic_year} · {vm.number} {item.version_number} ·{" "}
                {item.groups.map((g) => demoName(g, item.data_kind)).join(", ")}{" "}
                · {vm.semester} {item.semester}
              </option>
            ))}
          </select>
        </label>
        <button
          className="button button-quiet"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              const list = await publicationApi.list(scope);
              setItems(list);
              const id =
                list.find((p) => p.publication_id === value?.publication_id)
                  ?.publication_id ?? list[0]?.publication_id;
              if (id) {
                const next =
                  id === value?.publication_id
                    ? { ...filter, offset: 0 }
                    : emptyFilter();
                await load(id, next);
                setFilter(next);
              } else {
                setValue(null);
                setFilter(emptyFilter());
              }
            })
          }
        >
          {vm.refresh}
        </button>
        {!busy && !items.length && <p>{vm.noPublications}</p>}
      </section>
      {value && (
        <section className="editor-panel">
          <h2>
            {vm.number} {value.version_number} ·{" "}
            {demoName(value.name, value.data_kind)}
          </h2>
          <div className="publication-summary">
            <span>
              {value.data_kind === "synthetic" ? pm.synthetic : pm.college}
            </span>
            <StatusBadge tone={value.is_current ? "success" : "neutral"}>
              {value.is_current ? vm.current : vm.archived}
            </StatusBadge>
          </div>
          <dl className="publication-meta">
            <div>
              <dt>{vm.scope}</dt>
              <dd>{value.scope_name}</dd>
            </div>
            <div>
              <dt>{vm.publishedAt}</dt>
              <dd>
                {new Date(value.published_at).toLocaleString("kk-KZ", {
                  timeZone: value.timezone,
                })}
              </dd>
            </div>
            <div>
              <dt>{vm.revision}</dt>
              <dd>{value.revision}</dd>
            </div>
            <div>
              <dt>{vm.timezone}</dt>
              <dd>{value.timezone}</dd>
            </div>
          </dl>
          {!value.external_verified && (
            <p className="planning-warning">{vm.external}</p>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                const next = { ...filter, offset: 0 };
                await load(value.publication_id, next);
              });
            }}
          >
            <fieldset disabled={busy}>
              <legend>{vm.dates}</legend>
              <div className="planning-input-grid">
                <label>
                  {vm.start}
                  <input
                    type="date"
                    value={filter.start}
                    onChange={(e) =>
                      setFilter({ ...filter, start: e.target.value })
                    }
                  />
                </label>
                <label>
                  {vm.end}
                  <input
                    type="date"
                    value={filter.end}
                    onChange={(e) =>
                      setFilter({ ...filter, end: e.target.value })
                    }
                  />
                </label>
                <label>
                  {vm.view}
                  <select
                    value={filter.view}
                    onChange={(e) =>
                      setFilter({
                        ...filter,
                        view: e.target.value as PublicationFilter["view"],
                        resource_id: "",
                      })
                    }
                  >
                    <option value="group">{vm.group}</option>
                    <option value="teacher">{vm.teacher}</option>
                    <option value="room">{vm.room}</option>
                  </select>
                </label>
                <label>
                  {vm.resource}
                  <select
                    value={filter.resource_id}
                    onChange={(e) =>
                      setFilter({ ...filter, resource_id: e.target.value })
                    }
                  >
                    <option value="">{vm.all}</option>
                    {value.resources[filter.view].map((r) => (
                      <option key={r.id} value={r.id}>
                        {demoName(r.name, value.data_kind)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="version-actions">
                <button className="button button-primary">{vm.show}</button>
              </div>
            </fieldset>
          </form>
          <div
            className="editor-table-wrap publication-table"
            tabIndex={0}
            role="region"
            aria-label={vm.publication}
          >
            <table>
              <caption>
                {vm.number} {value.version_number} · {value.academic_year} ·{" "}
                {vm.semester} {value.semester}
              </caption>
              <thead>
                <tr>
                  <th scope="col">{vm.date}</th>
                  <th scope="col">{vm.time}</th>
                  <th scope="col">{vm.group}</th>
                  <th scope="col">{vm.subject}</th>
                  <th scope="col">{vm.teacher}</th>
                  <th scope="col">{vm.room}</th>
                </tr>
              </thead>
              <tbody>
                {value.events.map((e) => (
                  <tr key={e.id}>
                    <td>{e.date}</td>
                    <td>
                      {e.start}–{e.end}
                    </td>
                    <td>{demoName(e.group, value.data_kind)}</td>
                    <td>{demoName(e.subject, value.data_kind)}</td>
                    <td>{demoName(e.teacher, value.data_kind)}</td>
                    <td>{demoName(e.room, value.data_kind)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!value.events.length && <p>{vm.noEvents}</p>}
          <div className="editor-pagination">
            <button
              className="button button-quiet"
              disabled={busy || value.offset === 0}
              onClick={() =>
                void act(async () =>
                  load(value.publication_id, {
                    ...applied,
                    offset: Math.max(0, value.offset - value.limit),
                  }),
                )
              }
            >
              {vm.previous}
            </button>
            <span>
              {value.total ? value.offset + 1 : 0}–
              {Math.min(value.offset + value.limit, value.total)} /{" "}
              {value.total}
            </span>
            <button
              className="button button-quiet"
              disabled={busy || value.offset + value.limit >= value.total}
              onClick={() =>
                void act(async () =>
                  load(value.publication_id, {
                    ...applied,
                    offset: value.offset + value.limit,
                  }),
                )
              }
            >
              {vm.next}
            </button>
          </div>
        </section>
      )}
    </section>
  );
}
