import { History as HistoryIcon } from "lucide-react";
import type { PlaybackSnapshot } from "../engine";
import { clockDuration } from "./format";

/** Recent notable playback events: typos, corrections, autocorrect. */
export function ActivityLog({ snapshot }: { snapshot: PlaybackSnapshot }) {
  const items = snapshot.recent.slice(0, 4);
  return (
    <div className="activity" aria-label="Recent typing events">
      <span className="activity__title">
        <HistoryIcon size={13} aria-hidden="true" /> Corrections
      </span>
      {items.length === 0 ? (
        <span className="activity__empty">
          {snapshot.status === "completed" ? "No typos in this take." : "Typos and their fixes show up here as they happen."}
        </span>
      ) : (
        <ol className="activity__list">
          {items.map((e, i) => (
            <li key={`${e.at}-${i}`} className={i === 0 ? "is-latest" : ""}>
              <time>{clockDuration(e.at)}</time>
              <span>{e.note}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
