/**
 * Desktop only: asks before the window closes when closing would lose the user's
 * text (it isn't remembered) or interrupt a running session. Nothing is stored
 * unless the user chooses "Save text and quit".
 */
import { AlertTriangle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PlaybackStatus } from "../engine";
import type { Session } from "../state/useSession";
import { writeJSON, writeString } from "../state/storage";
import { Button } from "./controls";

export interface QuitRisk {
  /** A session is playing or paused (in the preview or typing into another app). */
  running: boolean;
  /** The text would be gone after quitting. */
  unsavedText: boolean;
}

export function quitRisk(text: string, rememberText: boolean, status: PlaybackStatus): QuitRisk | null {
  const running = status === "playing" || status === "paused";
  const unsavedText = text.trim().length > 0 && !rememberText;
  return running || unsavedText ? { running, unsavedText } : null;
}

export function QuitGuard({ session }: { session: Session }) {
  const [risk, setRisk] = useState<QuitRisk | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  // The close handler is registered once; it reads the latest state from here.
  const latest = useRef(session);
  latest.current = session;

  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
      getCurrentWindow()
        .onCloseRequested((e) => {
          // Tell the app this page is alive; otherwise it closes the window anyway after a
          // few seconds (a blank or hung page must never make Typewriter impossible to close).
          void import("@tauri-apps/api/core").then(({ invoke }) => invoke("close_answered")).catch(() => {});
          const s = latest.current;
          const r = quitRisk(s.text, s.prefs.rememberText, s.snapshot.status);
          if (!r) return; // nothing to lose: close normally
          e.preventDefault();
          setRisk(r);
        })
        .then((u) => (cancelled ? u() : (off = u))),
    );
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  useEffect(() => {
    if (risk && dialog.current && !dialog.current.open) {
      dialog.current.showModal(); // focuses the autofocus button: the safe choice
    }
  }, [risk]);

  const close = () => {
    dialog.current?.close();
    setRisk(null);
  };
  const quit = async (saveText: boolean) => {
    const s = latest.current;
    if (saveText) {
      // Write synchronously: the window is destroyed right after.
      writeJSON("prefs", { ...s.prefs, rememberText: true });
      writeString("text", s.text);
    }
    if (s.snapshot.status === "playing" || s.snapshot.status === "paused") s.stop();
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().destroy();
  };

  return (
    <dialog ref={dialog} className="quit-dialog" aria-labelledby="quit-title" onCancel={close} data-testid="quit-dialog">
      <h2 id="quit-title">
        <AlertTriangle size={18} aria-hidden="true" /> Quit Typewriter?
      </h2>
      {risk?.running ? (
        <p data-testid="quit-running">
          {session.snapshot.external
            ? "Typing into another app is still in progress. Quitting stops it at once; keys already typed stay in your document."
            : "A session is still playing. Quitting stops it."}
        </p>
      ) : null}
      {risk?.unsavedText ? (
        <p data-testid="quit-unsaved">
          Your text isn't saved on this computer, so it will be gone when Typewriter closes. Choose <strong>Save text and quit</strong> to find it here next
          time (this turns on "Remember my text" in Settings).
        </p>
      ) : null}
      <div className="quit-dialog__actions">
        <Button variant="secondary" onClick={close} autoFocus data-testid="quit-keep">
          Keep Typewriter open
        </Button>
        {risk?.unsavedText ? (
          <Button variant="secondary" onClick={() => void quit(true)} data-testid="quit-save">
            Save text and quit
          </Button>
        ) : null}
        <Button variant="danger" onClick={() => void quit(false)} data-testid="quit-confirm">
          {risk?.unsavedText ? "Quit without saving" : "Quit"}
        </Button>
      </div>
    </dialog>
  );
}
