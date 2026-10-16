/**
 * The small always-on-top status window shown while typing into another app.
 * It never takes focus on its own; clicking it does, which pauses typing (the
 * session only types into the window that had focus when the countdown ended).
 */
import "@fontsource-variable/inter";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { NativeUpdate } from "../desktop/bridge";
import { tauriBridge, type Bridge } from "../desktop/bridge";
import "../theme/tokens.css";
import "./hud.css";
import { LogoMark } from "../ui/Logo";

const LABEL: Record<NativeUpdate["phase"], string> = {
  waiting: "Click into your document",
  countdown: "Starting in",
  typing: "Typing",
  paused: "Paused",
  resuming: "Resuming",
  completed: "All keys sent",
  stopped: "Stopped",
  failed: "Couldn't type",
};

function Hud() {
  const [u, setU] = useState<NativeUpdate | null>(null);
  const [bridge, setBridge] = useState<Bridge | null>(null);
  useEffect(() => {
    let off: (() => void) | undefined;
    void tauriBridge().then((b) => {
      setBridge(b);
      off = b.onUpdate(setU);
    });
    return () => off?.();
  }, []);
  const phase = u?.phase ?? "waiting";
  const pct = u && u.totalMs > 0 ? Math.min(100, (u.elapsedMs / u.totalMs) * 100) : 0;
  const secs = u ? Math.max(1, Math.ceil(u.countdownMs / 1000)) : 0;
  const running = phase === "typing" || phase === "paused" || phase === "resuming" || phase === "countdown" || phase === "waiting";
  return (
    <div className={`hud hud--${phase}`} data-testid="hud">
      <div className="hud__row">
        <LogoMark size={30} />
        <div className="hud__text">
          <strong>
            {LABEL[phase]}
            {phase === "countdown" || (phase === "resuming" && u && u.countdownMs > 0) ? ` ${secs}` : ""}
          </strong>
          <span>
            {phase === "typing" && u?.target ? u.target.title : u?.message ?? (phase === "waiting" ? "Typing starts after the countdown." : "")}
          </span>
        </div>
      </div>
      <div className="hud__bar" aria-hidden="true">
        <div style={{ transform: `scaleX(${pct / 100})` }} />
      </div>
      <div className="hud__row hud__actions">
        <span className="hud__hint">
          Stop: <kbd>Ctrl+Shift+Space</kbd>
        </span>
        {running ? (
          <>
            {phase === "paused" ? (
              <button type="button" onClick={() => void bridge?.control("resume")}>
                Resume
              </button>
            ) : null}
            <button type="button" className="danger" onClick={() => void bridge?.control("stop")}>
              Stop
            </button>
          </>
        ) : (
          <button type="button" onClick={() => void bridge?.showMain()}>
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
