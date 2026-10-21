import type { DraftReport } from "../editor-api";
import { em, editorMessages } from "../locales/editor.kk";

export function ConflictReport({ report }: { report: DraftReport }) {
  return (
    <section className="editor-panel" aria-labelledby="draft-report-title">
      <div className="editor-panel-heading">
        <h2 id="draft-report-title">{em.report}</h2>
        <span>
          {em.revision} {report.revision}
        </span>
      </div>
      <p className="editor-help">{em.reportHint}</p>
      {report.conflicts.length ? (
        <div className="editor-conflicts" role="status">
          {report.conflicts.map((c, index) => (
            <article key={index}>
              <strong>
                {em.conflicts}: {em.views[c.resource_type]} · {c.resource_name}
              </strong>
              {c.events.map((e) => (
                <p key={e.id}>
                  {e.subject} · {e.group} · {e.teacher} · {e.room} · {e.date}{" "}
                  {e.start}–{e.end}
                </p>
              ))}
              <p>
                {em.intersection}:{" "}
                {c.intersections
                  .map((i) => `${i.date} ${i.start}–${i.end}`)
                  .join(", ")}
              </p>
            </article>
          ))}
        </div>
      ) : (
        <p className="editor-no-conflicts">{em.noConflicts}</p>
      )}
      {report.conflicts_truncated && <p className="notice">{em.truncated}</p>}
      {report.errors.length > 0 && (
        <div className="editor-issues">
          <h3>{em.errors}</h3>
          <ul>
            {report.errors.map((e, i) => (
              <li key={i}>
                {editorMessages[e.code] ?? em.unknown}
                {e.date && ` · ${e.date}`}
              </li>
            ))}
          </ul>
          {report.errors_truncated && <p>{em.truncated}</p>}
        </div>
      )}
      {report.questions.length > 0 && (
        <div className="editor-issues">
          <h3>{em.questions}</h3>
          <ul>
            {report.questions.map((q, i) => (
              <li key={i}>
                {editorMessages[q.code] ?? em.unknown}
                {q.date && ` · ${q.date}`}
                {q.count !== undefined && ` · ${q.count}`}
              </li>
            ))}
          </ul>
          {report.questions_truncated && <p>{em.truncated}</p>}
        </div>
      )}
      {report.hours.length > 0 && (
        <div className="editor-table-wrap">
          <table>
            <caption>{em.hours}</caption>
            <thead>
              <tr>
                <th>{em.group}</th>
                <th>{em.subject}</th>
                <th>{em.semester}</th>
                <th>{em.required}</th>
                <th>{em.planned}</th>
                <th>{em.remaining}</th>
              </tr>
            </thead>
            <tbody>
              {report.hours.map((h) => (
                <tr key={h.demand_id}>
                  <td>{h.group}</td>
                  <td>{h.subject}</td>
                  <td>{h.semester}</td>
                  <td>{h.required ?? "—"}</td>
                  <td>{h.planned}</td>
                  <td>{h.remaining ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ul className="editor-notes">
        {report.notes.map((note) => (
          <li key={note}>{editorMessages[note] ?? em.unknown}</li>
        ))}
      </ul>
      <p className="editor-help">{em.noActual}</p>
    </section>
  );
}
