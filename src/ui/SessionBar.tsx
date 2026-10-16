import { Check, Copy, Pause, Play, RotateCcw, Square } from "lucide-react";
import { useEffect, useState } from "react";
import type { PlaybackStatus } from "../engine";
import type { Session } from "../state/useSession";
import { Button } from "./controls";
import { clockDuration, nf, timeOfDay } from "./format";
import { StatusPill } from "./StatusPill";

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for browsers or frames that block the async clipboard API.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

export function SessionBar({ session, onCopy }: { session: Session; onCopy: () => void }) {
  const { snapshot, controller, estimate, blank, issues } = session;
  const status: PlaybackStatus = snapshot.status;
  const playing = status === "playing";
  const [live, setLive] = useState(() => controller.getElapsed());
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setLive(controller.getElapsed());
    if (!playing) return;
    const id = setInterval(() => setLive(controller.getElapsed()), 200);
    return () => clearInterval(id);
  }, [playing, controller, snapshot]);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(id);
  }, [copied]);

  const idle = status === "ready" || status === "empty";
  const total = idle ? estimate.totalMs : snapshot.totalMs;
  const elapsed = idle ? 0 : status === "completed" ? snapshot.totalMs : live;
  const remaining = Math.max(0, total - elapsed);
  const pct = total > 0 ? Math.min(100, (elapsed / total) * 100) : 0;
  const pctLabel = status === "completed" ? 100 : Math.floor(pct);
  const finishAt = playing ? new Date(Date.now() + remaining) : idle && total > 0 ? new Date(Date.now() + total) : null;
  const canStart = !blank && issues.length === 0;

  let primary: { label: string; icon: JSX.Element; onClick: () => void; disabled?: boolean; hint: string; testid: string };
  if (playing) primary = { label: "Pause", icon: <Pause size={17} />, onClick: session.pause, hint: "Space", testid: "btn-pause" };
  else if (status === "paused") primary = { label: "Resume", icon: <Play size={17} />, onClick: session.resume, hint: "Space", testid: "btn-resume" };
  else if (status === "completed" || status === "stopped" || status === "error")
    primary = { label: "Start again", icon: <Play size={17} />, onClick: session.start, disabled: !canStart, hint: "Ctrl + Enter", testid: "btn-start" };
  else primary = { label: "Start", icon: <Play size={17} />, onClick: session.start, disabled: !canStart, hint: "Ctrl + Enter", testid: "btn-start" };

  return (
    <section className={`session-bar session-bar--${status} ${playing ? "is-playing" : ""}`} aria-label="Playback controls and progress">
      <div className="session-bar__top">
        <StatusPill status={status} />
        <span className="session-bar__time" aria-hidden="true">
          {clockDuration(elapsed)} · {clockDuration(remaining)} left
        </span>
        <div className="session-bar__pct" aria-hidden="true">
          <span data-testid="progress-pct">{pctLabel}</span>
          <small>%</small>
        </div>
      </div>

      <div
        className="progress"
        role="progressbar"
        aria-label="Playback progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pctLabel}
        aria-valuetext={`${pctLabel}% · ${clockDuration(elapsed)} of ${clockDuration(total)}`}
      >
        <div className="progress__fill" style={{ transform: `scaleX(${(status === "completed" ? 100 : pct) / 100})` }} />
      </div>

      <dl className="metrics">
        <div className="metric">
          <dt>Elapsed</dt>
          <dd data-testid="elapsed">{clockDuration(elapsed)}</dd>
        </div>
        <div className="metric">
          <dt>Remaining</dt>
          <dd data-testid="remaining">{clockDuration(remaining)}</dd>
        </div>
        <div className="metric">
          <dt>Speed now</dt>
          <dd>{playing || status === "paused" ? `${Math.round(snapshot.currentWpm)} WPM` : `${Math.round(estimate.effectiveWpm)} WPM avg`}</dd>
        </div>
        <div className="metric">
          <dt>Typed</dt>
          <dd>
            {nf.format(idle ? 0 : snapshot.sourceDone)} / {nf.format(idle ? session.stats.characters : snapshot.sourceTotal)}
          </dd>
        </div>
        <div className="metric metric--wide">
          <dt>Finishes</dt>
          <dd>{finishAt ? `around ${timeOfDay(finishAt)}` : status === "completed" ? "done" : "–"}</dd>
        </div>
      </dl>

      <div className="controls" role="toolbar" aria-label="Playback">
        <Button
          variant="primary"
          size="lg"
          icon={primary.icon}
          onClick={primary.onClick}
          disabled={primary.disabled}
          title={`${primary.label} (${primary.hint})`}
          data-testid={primary.testid}
          className="controls__primary"
        >
          {primary.label}
        </Button>
        <Button
          icon={<RotateCcw size={16} />}
          onClick={session.restart}
          disabled={!(playing || status === "paused" || status === "completed" || status === "stopped") || !canStart}
          title="Restart from the beginning"
          data-testid="btn-restart"
        >
          Restart
        </Button>
        <Button
          icon={<Square size={14} />}
          onClick={session.stop}
          disabled={!(playing || status === "paused")}
          title="Stop (Esc)"
          data-testid="btn-stop"
        >
          Stop
        </Button>
        <Button
          variant="ghost"
          icon={copied ? <Check size={16} /> : <Copy size={16} />}
          onClick={() => {
            onCopy();
            setCopied(true);
          }}
          disabled={status !== "completed"}
          title={status === "completed" ? "Copy the finished text" : "Available when typing is complete"}
          data-testid="btn-copy"
        >
          {copied ? "Copied" : "Copy text"}
        </Button>
      </div>
      {!canStart && idle ? (
        <p className="session-bar__hint">{blank ? "Add some text to start." : issues[0]?.message}</p>
      ) : session.settingsChangedSinceStart ? (
        <p className="session-bar__hint">Settings changed. Restart to type with the new settings.</p>
      ) : null}
    </section>
  );
}
