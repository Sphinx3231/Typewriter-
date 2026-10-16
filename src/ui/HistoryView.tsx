import { CheckCircle2, CircleStop, Inbox, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import type { Session } from "../state/useSession";
import { ConfirmButton, IconButton, Segmented } from "./controls";
import { clockDuration, dateTime, nf } from "./format";

const PAGE = 15;

export function HistoryView({ session }: { session: Session }) {
  const [filter, setFilter] = useState<"all" | "completed" | "stopped">("all");
  const [page, setPage] = useState(0);
  const rows = useMemo(() => session.history.filter((h) => filter === "all" || h.status === filter), [session.history, filter]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const current = Math.min(page, pages - 1);
  const visible = rows.slice(current * PAGE, current * PAGE + PAGE);
  const totalWords = session.history.filter((h) => h.status === "completed").reduce((a, h) => a + h.words, 0);

  return (
    <div className="view view--history">
      <section className="panel" aria-labelledby="history-title">
        <header className="panel__head">
          <div className="panel__title-group">
            <h2 className="panel__title" id="history-title">
              Session history
            </h2>
            <p className="panel__sub">
              Stored only on this device. Only statistics are kept, never your text.
              {session.history.length ? ` ${nf.format(totalWords)} words typed in completed sessions.` : ""}
            </p>
          </div>
          <div className="panel__actions">
            <Segmented
              size="sm"
              label="Filter sessions"
              value={filter}
              onChange={(f) => {
                setFilter(f);
                setPage(0);
              }}
              options={[
                { value: "all", label: "All" },
                { value: "completed", label: "Completed" },
                { value: "stopped", label: "Stopped" },
              ]}
            />
            <ConfirmButton icon={<Trash2 size={15} />} confirmLabel="Delete all history?" onConfirm={session.clearHistory} disabled={!session.history.length}>
              Clear
            </ConfirmButton>
          </div>
        </header>

        {!session.prefs.keepHistory ? <p className="callout callout--info">History is turned off in Settings, so new sessions aren't recorded.</p> : null}

        {rows.length === 0 ? (
          <div className="empty-state">
            <Inbox size={26} aria-hidden="true" />
            <p className="empty-state__title">{session.history.length ? "No sessions match this filter" : "No sessions yet"}</p>
            <p className="empty-state__body">Finished and stopped sessions appear here with their length, speed and number of typos.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col" className="num">Words</th>
                  <th scope="col" className="num">Characters</th>
                  <th scope="col" className="num">Duration</th>
                  <th scope="col" className="num">Avg speed</th>
                  <th scope="col" className="num">Typos</th>
                  <th scope="col">Status</th>
                  <th scope="col"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {visible.map((h) => (
                  <tr key={h.id}>
                    <td>{dateTime(h.startedAt)}</td>
                    <td className="num">{nf.format(h.words)}</td>
                    <td className="num">{nf.format(h.characters)}</td>
                    <td className="num">
                      {clockDuration(h.elapsedMs)}
                      {h.status === "stopped" ? <span className="muted"> / {clockDuration(h.plannedMs)}</span> : null}
                    </td>
                    <td className="num">{h.wpm} WPM</td>
                    <td className="num">{h.mistakeLevel === "off" ? "off" : h.mistakes}</td>
                    <td>
                      <span className={`tag tag--${h.status}`}>
                        {h.status === "completed" ? <CheckCircle2 size={13} aria-hidden="true" /> : <CircleStop size={13} aria-hidden="true" />}
                        {h.status === "completed" ? "Completed" : "Stopped"}
                      </span>
                    </td>
                    <td className="actions">
                      <IconButton label="Delete this session" onClick={() => session.deleteHistoryEntry(h.id)}>
                        <Trash2 size={15} />
                      </IconButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rows.length > PAGE ? (
          <nav className="pager" aria-label="History pages">
            <span>
              {current * PAGE + 1}–{Math.min(rows.length, current * PAGE + PAGE)} of {rows.length}
            </span>
            <div className="pager__btns">
              <button type="button" className="btn btn--ghost btn--sm" disabled={current === 0} onClick={() => setPage(current - 1)}>
                Previous
              </button>
              <button type="button" className="btn btn--ghost btn--sm" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
                Next
              </button>
            </div>
          </nav>
        ) : null}
      </section>
    </div>
  );
}
