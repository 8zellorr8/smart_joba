import type { Diagnostic, IndependentReport } from "../planning-api";
import { pm, planningMessages } from "../locales/planning.kk";
import { demoName } from "../demo-labels";

export function Diagnostics({
  items,
  dataKind,
}: {
  items: Diagnostic[];
  dataKind?: string;
}) {
  return (
    <ul className="planning-diagnostics">
      {items.map((item, i) => (
        <li key={i}>
          {planningMessages[item.code] ?? pm.error}
          {item.date && <> · {item.date}</>}
          {[item.subject, item.group, item.resource_name].filter(Boolean)
            .length > 0 && (
            <>
              {" "}
              ·{" "}
              {[item.subject, item.group, item.resource_name]
                .filter(Boolean)
                .map((value) => demoName(value!, dataKind))
                .join(" · ")}
            </>
          )}
          {item.source && (
            <>
              {" "}
              · {pm.source}:{" "}
              {typeof item.source === "string"
                ? item.source
                : item.source.coordinate}
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

export function ValidationView({
  report,
  stale = false,
  dataKind,
}: {
  report: IndependentReport;
  stale?: boolean;
  dataKind?: string;
}) {
  return (
    <section className="editor-panel validation-view" aria-label={pm.validate}>
      <h2>{pm.validate}</h2>
      <p
        className={
          stale || !report.valid ? "planning-warning" : "planning-success"
        }
        role="status"
      >
        {stale ? pm.reportStale : report.valid ? pm.valid : pm.invalid}
      </p>
      <p>
        {pm.revision}: {report.identity.revision ?? "—"} · {pm.events}:{" "}
        {report.event_count} · {pm.complete}: {report.complete ? pm.yes : pm.no}
      </p>
      <p>
        {pm.semester}: {report.check_scope.semester} · {pm.groups}:{" "}
        {report.check_scope.group_ids.length} · {report.elapsed_seconds} с
      </p>
      {report.notes.map((n) => (
        <p className="planning-warning" key={n}>
          {planningMessages[n] ?? pm.error}
        </p>
      ))}
      {!!report.errors.length && (
        <details open>
          <summary>
            {pm.errors} ({report.errors.length})
          </summary>
          <Diagnostics items={report.errors} dataKind={dataKind} />
        </details>
      )}
      {!!report.questions.length && (
        <details open>
          <summary>
            {pm.questions} ({report.questions.length})
          </summary>
          <Diagnostics items={report.questions} dataKind={dataKind} />
        </details>
      )}
      {!!report.conflicts.length && (
        <details open>
          <summary>
            {pm.conflicts} ({report.conflicts.length})
          </summary>
          <ul>
            {report.conflicts.map((c, i) => (
              <li key={i}>
                {c.resource_type === "teacher"
                  ? pm.teacher
                  : c.resource_type === "group"
                    ? pm.group
                    : pm.room}
                : {demoName(c.resource_name ?? c.resource_id, dataKind)} ·{" "}
                {c.events
                  ?.map(
                    (e) =>
                      `${demoName(e.subject, dataKind)} (${demoName(e.group, dataKind)}, ${e.start}–${e.end})`,
                  )
                  .join(" ↔ ") ?? c.event_ids.join(" ↔ ")}{" "}
                · {c.dates.join(", ")}
              </li>
            ))}
          </ul>
        </details>
      )}
      {(report.errors_truncated ||
        report.questions_truncated ||
        report.conflicts_truncated) && <p role="alert">{pm.truncated}</p>}
      <h3>{pm.hours}</h3>
      <p>{pm.academic}</p>
      <div
        className="planning-table"
        role="region"
        aria-label={pm.hours}
        tabIndex={0}
      >
        <table>
          <thead>
            <tr>
              <th scope="col">{pm.subject}</th>
              <th scope="col">{pm.group}</th>
              <th scope="col">{pm.required}</th>
              <th scope="col">{pm.planned}</th>
              <th scope="col">{pm.remaining}</th>
            </tr>
          </thead>
          <tbody>
            {report.hours.map((h) => (
              <tr key={h.demand_id}>
                <td>{demoName(h.subject, dataKind)}</td>
                <td>{demoName(h.group, dataKind)}</td>
                <td>{h.required ?? "?"}</td>
                <td>{h.planned}</td>
                <td>{h.remaining ?? "?"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
