import { CheckCircle2, CircleAlert, CircleDashed, CirclePause, CircleStop, Loader } from "lucide-react";
import type { PlaybackStatus } from "../engine";

const LABEL: Record<PlaybackStatus, string> = {
  empty: "No text",
  ready: "Ready",
  playing: "Typing",
  paused: "Paused",
  completed: "Complete",
  stopped: "Stopped",
  error: "Error",
};

const ICON: Record<PlaybackStatus, JSX.Element> = {
  empty: <CircleDashed size={14} />,
  ready: <CircleDashed size={14} />,
  playing: <Loader size={14} className="spin" />,
  paused: <CirclePause size={14} />,
  completed: <CheckCircle2 size={14} />,
  stopped: <CircleStop size={14} />,
  error: <CircleAlert size={14} />,
};

/** Playback state shown with an icon and a word, never by color alone. */
export function StatusPill({ status, compact = false }: { status: PlaybackStatus; compact?: boolean }) {
  return (
    <span className={`status-pill status-pill--${status} ${compact ? "status-pill--compact" : ""}`} data-testid="status">
      <span aria-hidden="true" className="status-pill__icon">
        {ICON[status]}
      </span>
      <span>{LABEL[status]}</span>
    </span>
  );
}
