/**
 * The small always-on-top status window shown while typing into another app.
 * It never takes focus on its own. Clicking it does, and typing then pauses,
 * because the session only types into the window that had focus when the
 * countdown ended. So every control here is safe to click mid-session.
 */
import "@fontsource-variable/inter";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { NativeUpdate } from "../desktop/bridge";
import { tauriBridge, type Bridge } from "../desktop/bridge";
import "../theme/tokens.css";
import "./hud.css";
import { LogoMark } from "../ui/Logo";
import { clockDuration } from "../ui/format";

const LABEL: Record<NativeUpdate["phase"], string> = {
  preparing: "Getting ready",
  waiting: "Click into your document",
  countdown: "Starting in",
  typing: "Typing",
  paused: "Paused",
  resuming: "Resuming",
  completed: "All keys sent",
  stopped: "Stopped",
  failed: "Couldn't type",
};

function detail(u: NativeUpdate | null): string {
  if (!u) return "Getting the keyboard ready. Nothing is typed yet.";
  switch (u.phase) {
    case "preparing":
      return `${u.message ?? "Getting the keyboard ready…"} Nothing is typed yet.`;
    case "waiting":
      return "Typing starts after the countdown. Nothing is typed yet.";
    case "countdown":
      return "Keep the cursor where the text should go.";
    case "typing":
      return u.message ?? (u.target ? `Into “${u.target.title}”` : "");
    case "completed":
      return "Not checked yet: copy the text from your document, then press Check in Typewriter.";
    case "stopped":
      return u.message ?? "Keys already typed stay in your document.";
    case "paused":
      return !u.message || u.message === "Paused." ? "Press Resume, then click back into your document." : u.message;
    default:
      return u.message ?? "";
  }
}

function Hud() {
  const [u, setU] = useState<NativeUpdate | null>(null);
  const [bridge, setBridge] = useState<Bridge | null>(null);
  useEffect(() => {
    let off: (() => void) | undefined;
    void tauriBridge().then((b) => {
      setBridge(b);
      off = b.onUpdate(setU);
      // This window may open after the session has already moved on: catch up.
      void b.state?.().then((s) => s && setU((cur) => cur ?? s)).catch(() => {});
    });
    // Follow theme changes made in the main window (same storage, other window).
    const onStorage = (e: StorageEvent) => {
      if (e.key !== "typewriter:theme") return;
      const dark = e.newValue ? e.newValue === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
      document.documentElement.dataset.theme = dark ? "dark" : "light";
    };
    addEventListener("storage", onStorage);
    return () => {
      off?.();
      removeEventListener("storage", onStorage);
    };
  }, []);
  const phase = u?.phase ?? "preparing";
  const pct = u && u.totalMs > 0 ? Math.min(100, (u.elapsedMs / u.totalMs) * 100) : 0;
  const secs = u ? Math.max(1, Math.ceil(u.countdownMs / 1000)) : 0;
  const counting = phase === "countdown" || (phase === "resuming" && !!u && u.countdownMs > 0);
  const running = ["preparing", "waiting", "countdown", "typing", "paused", "resuming"].includes(phase);
  const remaining = u ? Math.max(0, u.totalMs - u.elapsedMs) : 0;
  const shortcut = u?.shortcutRegistered !== false;
  const control = (c: "pause" | "resume" | "stop") => void bridge?.control(c).catch(() => {});
  return (
    <div className={`hud hud--${phase}`} data-testid="hud" data-phase={phase}>
      <div className="hud__row">
        <LogoMark size={30} />
        <div className="hud__text">
          <strong data-testid="hud-label">
            {LABEL[phase]}
            {counting ? ` ${secs}` : ""}
          </strong>
        </div>
        {u && u.totalMs > 0 ? (
          <span className="hud__pct" data-testid="hud-pct">
            {Math.floor(pct)}%
          </span>
        ) : null}
      </div>
      <p className="hud__detail" data-testid="hud-detail">
        {detail(u)}
      </p>
      <p className="hud__hint" data-testid="hud-hint">
        {shortcut ? (
          <>
            Stop: <kbd>Ctrl+Shift+Space</kbd> or mouse to the top-left corner
          </>
        ) : (
          <span className="hud__warn">No stop shortcut: use Stop or move the mouse to the top-left corner</span>
        )}
      </p>
      <div className="hud__bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(pct)} aria-label="Typing progress">
        <div style={{ transform: `scaleX(${pct / 100})` }} />
      </div>
      <div className="hud__row hud__actions">
        <span className="hud__left" data-testid="hud-left">
          {running && u && u.totalMs > 0 ? `${clockDuration(remaining)} left` : ""}
        </span>
        {running ? (
          <>
            {phase === "typing" ? (
              <button type="button" onClick={() => control("pause")} data-testid="hud-pause">
                Pause
              </button>
            ) : null}
            {phase === "paused" ? (
              <button type="button" onClick={() => control("resume")} data-testid="hud-resume">
                Resume
              </button>
            ) : null}
            <button type="button" className="danger" onClick={() => control("stop")} data-testid="hud-stop">
              Stop
            </button>
          </>
        ) : (
          <button type="button" onClick={() => void bridge?.showMain()} data-testid="hud-open">
            Open Typewriter
          </button>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById("hud")!).render(
  <StrictMode>
    <Hud />
  </StrictMode>,
);
