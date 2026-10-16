import { AlertTriangle, CheckCircle2, ClipboardCheck, Keyboard, MonitorSmartphone, MousePointerClick, ShieldCheck, Timer } from "lucide-react";
import { useId, useState } from "react";
import type { ExternalInfo } from "../engine";
import type { Session } from "../state/useSession";
import { Button, Field, NumberInput, Segmented, Switch, useToast } from "./controls";

export const STOP_SHORTCUT = "Ctrl + Shift + Space";

export function externalLabel(ext: ExternalInfo): string | undefined {
  switch (ext.phase) {
    case "waiting":
      return "Switch to your document";
    case "countdown":
      return `Starting in ${Math.max(1, Math.ceil(ext.countdownMs / 1000))}`;
    case "typing":
      return ext.target ? `Typing into ${ext.target.appName || "app"}` : "Typing";
    case "paused":
      return "Paused";
    case "resuming":
      return ext.countdownMs > 0 ? `Resuming in ${Math.ceil(ext.countdownMs / 1000)}` : "Click back into your document";
    case "completed":
      return ext.verification === "verified" ? "Verified" : "Sent";
    case "failed":
      return "Couldn't type";
    default:
      return undefined;
  }
}

/** Live guidance and verification while typing into another app. */
export function ExternalStatus({ session }: { session: Session }) {
  const ext = session.snapshot.external!;
  const toast = useToast();
  const [checking, setChecking] = useState(false);
  const verify = async () => {
    setChecking(true);
    const r = await session.verifyDestination();
    setChecking(false);
    if (r?.status === "empty") toast(r.detail, "error");
  };

  let body: JSX.Element | null = null;
  if (ext.phase === "waiting")
    body = (
      <p>
        <MousePointerClick size={15} aria-hidden="true" /> Switch to your document and click exactly where the text should start. The countdown begins when
        Typewriter loses focus. Nothing is typed before it ends.
      </p>
    );
  else if (ext.phase === "countdown")
    body = (
      <p className="ext-status__countdown" data-testid="ext-countdown">
        <Timer size={15} aria-hidden="true" /> Typing starts in <strong>{Math.max(1, Math.ceil(ext.countdownMs / 1000))}</strong>. Keep the cursor where you
        want the text.
      </p>
    );
  else if (ext.phase === "typing")
    body = (
      <p>
        <Keyboard size={15} aria-hidden="true" /> Typing into <strong>{ext.target?.title || "the selected window"}</strong>.{" "}
        {ext.message ? `${ext.message} ` : ""}Emergency stop: <kbd>{STOP_SHORTCUT}</kbd> or move the mouse to the top-left corner.
      </p>
    );
  else if (ext.phase === "paused" || ext.phase === "resuming")
    body = (
      <p>
        <AlertTriangle size={15} aria-hidden="true" /> {ext.message ?? "Paused."} {ext.phase === "paused" ? "Press Resume, then click back into your document." : ""}
      </p>
    );
  else if (ext.phase === "stopped")
    body = <p>{ext.reason === "failsafe" ? "Stopped because the mouse moved to the top-left corner." : "Stopped. Keys already typed stay in your document."}</p>;
  else if (ext.phase === "failed")
    body = (
      <p role="alert">
        <AlertTriangle size={15} aria-hidden="true" /> {ext.message ?? "Typing into the other app failed."}
      </p>
    );
  else if (ext.phase === "completed")
    body =
      ext.verification === "verified" ? (
        <p className="ext-status__ok" data-testid="ext-verified">
          <CheckCircle2 size={15} aria-hidden="true" /> {ext.verificationDetail}
        </p>
      ) : (
        <div className="ext-status__verify">
          <p data-testid="ext-unverified">
            {ext.verification === "mismatch" ? (
              <>
                <AlertTriangle size={15} aria-hidden="true" /> <strong>The document text doesn't match.</strong> {ext.verificationDetail} Your document app may have
                changed it (autocorrect, smart quotes, automatic lists).
              </>
            ) : (
              <>
                Every key was sent, but Typewriter can't see inside other apps, so <strong>the document hasn't been checked</strong>. To check: select the typed text
                in your document, copy it, then press Check.
              </>
            )}
          </p>
          <Button size="sm" variant="secondary" icon={<ClipboardCheck size={14} />} onClick={verify} disabled={checking} data-testid="btn-verify">
            {checking ? "Checking…" : "Check copied text"}
          </Button>
        </div>
      );
  return (
    <div className={`ext-status ext-status--${ext.phase}`} role="status" aria-live="polite" data-testid="ext-status">
      {body}
      {!ext.shortcutRegistered && (ext.phase === "typing" || ext.phase === "countdown") ? (
        <p className="ext-status__warn">The emergency shortcut couldn't be registered on this system. Use the mouse corner or the Stop button.</p>
      ) : null}
    </div>
  );
}

/** Steps shown in the playback panel before typing into another app. */
export function ExternalGuide({ session }: { session: Session }) {
  const sec = session.prefs.countdownSec;
  return (
    <div className="ext-guide" data-testid="ext-guide">
      <p className="ext-guide__title">Type into another app</p>
      <ol>
        <li>Paste your text and choose the duration and realism.</li>
        <li>
          Press <strong>Type into app</strong>. Typewriter {session.prefs.minimizeWhileTyping ? "minimises itself" : "steps aside"}.
        </li>
        <li>Click into your document (for example Google Docs) exactly where the text should go.</li>
        <li>After a {sec}-second countdown, the text is typed there with real key presses.</li>
      </ol>
      <p className="ext-guide__safety">
        <ShieldCheck size={15} aria-hidden="true" /> Stops at once with <kbd>{STOP_SHORTCUT}</kbd> or by moving the mouse to the top-left corner. Pauses if you
        click into another window, and never types into Typewriter itself or a password field it can detect.
      </p>
    </div>
  );
}

/** Output destination settings for the session settings panel. */
export function OutputSettings({ session }: { session: Session }) {
  const cid = useId();
  const running = session.snapshot.status === "playing" || session.snapshot.status === "paused";
  if (!session.desktop)
    return (
      <div className="settings__group">
        <h3 className="settings__heading">Output</h3>
        <p className="callout callout--info output-note">
          <MonitorSmartphone size={16} aria-hidden="true" className="callout__icon" />
          <span>This preview types inside Typewriter. To type into Google Docs or any other app, use the Typewriter desktop app.</span>
        </p>
      </div>
    );
  const { support } = session;
  return (
    <div className="settings__group">
      <h3 className="settings__heading">Output</h3>
      <Segmented
        label="Where to type"
        value={session.destination}
        onChange={session.setDestination}
        options={[
          { value: "preview", label: "Preview here", title: "Type inside Typewriter's playback panel" },
          { value: "external", label: "Into another app", title: "Type into the app you click into, like Google Docs" },
        ]}
      />
      {running ? <p className="field__hint">Change this after the current session ends.</p> : null}
      {session.destination === "external" ? (
        <>
          <div className={`permission permission--${support.available ? "ok" : "no"}`} data-testid="ext-support">
            {support.available ? <ShieldCheck size={15} aria-hidden="true" /> : <AlertTriangle size={15} aria-hidden="true" />}
            <span>{support.message}</span>
            {!support.available && support.state === "permission-denied" ? (
              <Button size="sm" variant="secondary" onClick={() => void session.refreshSupport(true)}>
                Grant access
              </Button>
            ) : null}
            {!support.available ? (
              <Button size="sm" variant="ghost" onClick={() => void session.refreshSupport(false)}>
                Check again
              </Button>
            ) : null}
          </div>
          <Field label="Countdown before typing" htmlFor={cid} hint="Time to click into your document after leaving Typewriter.">
            <NumberInput
              id={cid}
              value={session.prefs.countdownSec}
              min={2}
              max={30}
              suffix="sec"
              onCommit={(countdownSec) => session.updatePrefs({ countdownSec })}
            />
          </Field>
          <Switch
            checked={session.prefs.minimizeWhileTyping}
            onChange={(minimizeWhileTyping) => session.updatePrefs({ minimizeWhileTyping })}
            label="Minimise Typewriter while typing"
            description="Brings your document back to the front. A small status window stays on top."
          />
        </>
      ) : null}
    </div>
  );
}
