import { ArrowDown, CheckCircle2, CircleAlert, Keyboard, OctagonX, Pause } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PlaybackController, PlaybackSnapshot } from "../engine";
import { clockDuration, longDuration, nf } from "./format";

const FIX_HIGHLIGHT_MS = 900;

/**
 * The dedicated typing area. Renders the controller's buffer directly into the
 * DOM: settled text is appended to one text node, and only the short active
 * region (pending typos, a fresh correction, text after a moved caret) is
 * rebuilt as spans. That keeps long texts smooth.
 */
export function PlaybackSurface({
  controller,
  snapshot,
  estimateMs,
  words,
  blank,
}: {
  controller: PlaybackController;
  snapshot: PlaybackSnapshot;
  estimateMs: number;
  words: number;
  blank: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const settledRef = useRef<HTMLSpanElement>(null);
  const activeRef = useRef<HTMLSpanElement>(null);
  const caretRef = useRef<HTMLSpanElement | null>(null);
  const cache = useRef({ len: 0 });
  const follow = useRef(true);
  const programmatic = useRef(false);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [detached, setDetached] = useState(false);
  const status = snapshot.status;
  const hasOutput = snapshot.eventIndex > 0 || status === "playing";

  useLayoutEffect(() => {
    const caret = document.createElement("span");
    caret.className = "caret";
    caret.setAttribute("aria-hidden", "true");
    caretRef.current = caret;
  }, []);

  useEffect(() => {
    const render = () => {
      const settled = settledRef.current;
      const active = activeRef.current;
      const caret = caretRef.current;
      if (!settled || !active || !caret) return;
      const b = controller.buffer;
      const n = b.cells.length;
      const dirty = b.takeDirty();
      const firstErr = (() => {
        const i = b.errs.indexOf(true);
        return i < 0 ? n : i;
      })();
      let fixStart = n;
      let fixEnd = n;
      const tl = controller.getTimeline();
      if (b.lastFix && tl && b.lastFix.eventIndex >= 0) {
        const at = tl.events[b.lastFix.eventIndex]?.at ?? -Infinity;
        if (controller.getElapsed() - at < FIX_HIGHLIGHT_MS) {
          fixStart = b.lastFix.start;
          fixEnd = b.lastFix.end;
        }
      }
      const lo = Math.min(b.caret, firstErr, fixStart, n);

      // Settled text: reuse what is already in the DOM where possible.
      const c = cache.current;
      if (dirty < c.len || lo < c.len) {
        settled.textContent = b.cells.slice(0, lo).join("");
        c.len = lo;
      } else if (lo > c.len) {
        const add = b.cells.slice(c.len, lo).join("");
        const node = settled.firstChild as Text | null;
        if (node) node.appendData(add);
        else settled.textContent = add;
        c.len = lo;
      }

      // Active region, rebuilt each time (normally only a few characters).
      const frag = document.createDocumentFragment();
      let run = "";
      let runClass = "";
      const flush = () => {
        if (!run) return;
        if (runClass) {
          const s = document.createElement("span");
          s.className = runClass;
          s.textContent = run;
          frag.appendChild(s);
        } else frag.appendChild(document.createTextNode(run));
        run = "";
      };
      for (let i = lo; i <= n; i++) {
        if (i === b.caret) {
          flush();
          frag.appendChild(caret);
        }
        if (i === n) break;
        const cls = b.errs[i] ? "typo" : i >= fixStart && i < fixEnd ? "fixed" : "";
        if (cls !== runClass) {
          flush();
          runClass = cls;
        }
        run += b.cells[i];
      }
      flush();
      active.replaceChildren(frag);

      // Solid caret while keys are landing, blinking when idle.
      caret.classList.add("is-typing");
      if (typingTimer.current) clearTimeout(typingTimer.current);
      typingTimer.current = setTimeout(() => caret.classList.remove("is-typing"), 450);

      // Keep the caret in view unless the reader scrolled away.
      const sc = scrollRef.current;
      if (sc && follow.current) {
        const top = caret.offsetTop;
        const lh = caret.offsetHeight || 24;
        const pad = lh * 2.5;
        let target = sc.scrollTop;
        if (top + lh + pad > sc.scrollTop + sc.clientHeight) target = top + lh + pad - sc.clientHeight;
        else if (top - pad < sc.scrollTop) target = Math.max(0, top - pad);
        if (target !== sc.scrollTop) {
          programmatic.current = true;
          sc.scrollTop = target;
        }
      }
    };
    render();
    const unsub = controller.subscribe(render);
    // Let the correction highlight fade even if no new keystroke arrives.
    const id = setInterval(() => {
      if (controller.buffer.lastFix) render();
    }, 300);
    return () => {
      unsub();
      clearInterval(id);
    };
  }, [controller]);

  const onScroll = () => {
    const sc = scrollRef.current;
    if (!sc) return;
    if (programmatic.current) {
      programmatic.current = false;
      return;
    }
    const caret = caretRef.current;
    const top = caret?.offsetTop ?? 0;
    const visible = top >= sc.scrollTop - 4 && top <= sc.scrollTop + sc.clientHeight;
    follow.current = visible;
    setDetached(!visible);
  };

  const jumpToCaret = () => {
    follow.current = true;
    setDetached(false);
    const sc = scrollRef.current;
    const caret = caretRef.current;
    if (sc && caret) {
      programmatic.current = true;
      sc.scrollTop = Math.max(0, caret.offsetTop - sc.clientHeight / 2);
    }
  };

  useEffect(() => {
    if (status === "ready" || status === "empty") {
      follow.current = true;
      setDetached(false);
    }
  }, [status]);

  return (
    <div className={`paper paper--${status}`} data-testid="playback">
      <div className="paper__scroll" ref={scrollRef} onScroll={onScroll} tabIndex={0} aria-label="Typed output" role="region">
        <div className="paper__text" data-testid="playback-text" aria-hidden={!hasOutput}>
          <span ref={settledRef} />
          <span ref={activeRef} />
        </div>
        {!hasOutput ? (
          <div className="paper__empty">
            <span className="paper__empty-icon" aria-hidden="true">
              <Keyboard size={22} />
            </span>
            {blank ? (
              <>
                <p className="paper__empty-title">Your text will be typed here</p>
                <p className="paper__empty-body">Paste or write something in the editor, choose how long it should take, then press Start.</p>
              </>
            ) : (
              <>
                <p className="paper__empty-title">Ready to type {nf.format(words)} {words === 1 ? "word" : "words"}</p>
                <p className="paper__empty-body">
                  Press Start and it will take about {longDuration(estimateMs)}. Shortcut: <kbd>Ctrl</kbd> + <kbd>Enter</kbd>
                </p>
              </>
            )}
          </div>
        ) : null}
      </div>
      {detached && (status === "playing" || status === "paused") ? (
        <button type="button" className="paper__jump" onClick={jumpToCaret}>
          <ArrowDown size={14} aria-hidden="true" /> Follow the caret
        </button>
      ) : null}
      {status === "paused" ? (
        <div className="paper__badge paper__badge--paused" role="status">
          <Pause size={13} aria-hidden="true" /> Paused at {clockDuration(snapshot.elapsedMs)}
        </div>
      ) : null}
      {status === "completed" ? (
        <div className="paper__badge paper__badge--done" role="status" data-testid="verified-badge">
          <CheckCircle2 size={14} aria-hidden="true" /> Complete · matches your text exactly
        </div>
      ) : null}
      {status === "stopped" ? (
        <div className="paper__badge paper__badge--stopped" role="status">
          <OctagonX size={14} aria-hidden="true" /> Stopped at {Math.floor(snapshot.progress * 100)}%
        </div>
      ) : null}
      {status === "error" && snapshot.error ? (
        <div className="paper__badge paper__badge--error" role="alert">
          <CircleAlert size={14} aria-hidden="true" /> {snapshot.error}
        </div>
      ) : null}
    </div>
  );
}
