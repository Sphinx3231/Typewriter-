import { AlertTriangle, CheckCircle2, ClipboardCheck, Keyboard, LoaderCircle, MonitorSmartphone, MousePointerClick, ShieldCheck, Timer } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { ExternalInfo } from "../engine";
import type { Host } from "../platform";
import type { Session } from "../state/useSession";
import { Button, Field, NumberInput, Segmented, Switch, useToast } from "./controls";

export const DESKTOP_STOP_SHORTCUT = "Ctrl + Shift + Space";
const EXTENSION_DEFAULT_STOP = "Alt+Shift+Period";

/** The real emergency-stop shortcut for this host (in Chrome, users can change it). */
export function useStopShortcut(host: Host): string {
  const [key, setKey] = useState(host === "desktop" ? DESKTOP_STOP_SHORTCUT : EXTENSION_DEFAULT_STOP);
  useEffect(() => {
    if (host !== "extension") return;
    void import("../extension/bridge").then((m) => m.stopShortcut()).then((k) => setKey(k || "not set (chrome://extensions/shortcuts)"));
  }, [host]);
  return key;
}

export function externalLabel(ext: ExternalInfo): string | undefined {
  switch (ext.phase) {
    case "preparing":
      return "Getting ready";
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

/** Live guidance and verification while typing outside the preview. */
export function ExternalStatus({ session }: { session: Session }) {
  const ext = session.snapshot.external!;
  const toast = useToast();
  const stop = useStopShortcut(session.host);
  const inChrome = session.host === "extension";
  const [checking, setChecking] = useState(false);
  const verify = async () => {
    setChecking(true);
    const r = await session.verifyDestination();
    setChecking(false);
    if (r?.status === "empty") toast(r.detail, "error");
  };

  let body: JSX.Element | null = null;
  if (ext.phase === "preparing")
    body = (
      <p data-testid="ext-preparing">
        <LoaderCircle size={15} aria-hidden="true" className="spin" /> {ext.message ?? "Getting the keyboard ready…"} Nothing is typed yet. You can Cancel at any time.
      </p>
    );
  else if (ext.phase === "waiting")
    body = (
      <p>
        <MousePointerClick size={15} aria-hidden="true" />{" "}
        {inChrome
          ? ext.message ?? "Switch to the tab you want to type into."
          : ext.message ?? "Switch to your document and click exactly where the text should start. The countdown starts from your click."}{" "}
        Nothing is typed yet.
      </p>
    );
  else if (ext.phase === "countdown")
    body = (
      <p className="ext-status__countdown" data-testid="ext-countdown">
        <Timer size={15} aria-hidden="true" /> Typing starts in <strong>{Math.max(1, Math.ceil(ext.countdownMs / 1000))}</strong>.{" "}
        {inChrome ? "Click in the page exactly where the text should start." : "Keep the cursor where you want the text. A click starts the countdown again."}
      </p>
    );
  else if (ext.phase === "typing")
    body = (
      <p>
        <Keyboard size={15} aria-hidden="true" /> Typing into <strong>{ext.target?.title || "the selected window"}</strong>.{" "}
        {ext.message && !inChrome ? `${ext.message} ` : ""}Emergency stop: <kbd>{stop}</kbd>{" "}
        {inChrome ? "or the Stop button. Closing this panel or Chrome's debugging bar also stops it." : "or move the mouse to the top-left corner."}
      </p>
    );
  else if (ext.phase === "paused" || ext.phase === "resuming")
    body = (
      <p>
        <AlertTriangle size={15} aria-hidden="true" /> {ext.message ?? "Paused."}{" "}
        {ext.phase === "paused" ? (inChrome ? "Press Resume, then go back to the tab." : "Press Resume, then click back into your document.") : ""}
      </p>
    );
  else if (ext.phase === "stopped")
    body = (
      <p>
        {ext.reason === "failsafe"
          ? "Stopped because the mouse moved to the top-left corner."
          : ext.message ?? "Stopped. Keys already typed stay in your document."}
      </p>
    );
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
                <AlertTriangle size={15} aria-hidden="true" /> <strong>The document text doesn't match.</strong> {ext.verificationDetail}
              </>
            ) : (
              <>
                Every key was sent, but <strong>the document hasn't been checked</strong>. {ext.verificationDetail ?? "Typewriter can't see inside other apps."} To
                check: select the typed text in your document, copy it, then press Check.
              </>
            )}
          </p>
          <Button size="sm" variant="secondary" icon={<ClipboardCheck size={14} />} onClick={verify} disabled={checking} data-testid="btn-verify">
            {checking ? "Checking…" : "Check copied text"}
          </Button>
        </div>
      );
  return (
    <div className={`ext-status ext-status--${ext.phase}`} role="status" aria-live="polite" data-testid="ext-status" data-phase={ext.phase}>
      {body}
      {!ext.shortcutRegistered && (ext.phase === "typing" || ext.phase === "countdown") ? (
        <p className="ext-status__warn">
          {inChrome
            ? "No keyboard shortcut is set for Stop typing (chrome://extensions/shortcuts). Use the Stop button."
            : "The emergency shortcut couldn't be registered on this system. Use the mouse corner or the Stop button."}
        </p>
      ) : null}
    </div>
  );
}

/** Steps shown in the playback panel before typing outside the preview. */
export function ExternalGuide({ session }: { session: Session }) {
  const sec = session.prefs.countdownSec;
  const stop = useStopShortcut(session.host);
  if (session.host === "extension")
    return (
      <div className="ext-guide" data-testid="ext-guide">
        <p className="ext-guide__title">Type into a web page</p>
        <ol>
          <li>Paste your text and choose the duration and realism.</li>
          <li>
            Press <strong>Type into page</strong>. The first time, Chrome asks to let Typewriter control typing in a tab.
          </li>
          <li>In the page (for example Google Docs), click exactly where the text should go.</li>
          <li>After a {sec}-second countdown, the text is typed there as real key presses.</li>
        </ol>
        <p className="ext-guide__safety">
          <ShieldCheck size={15} aria-hidden="true" /> Stop any time with <kbd>{stop}</kbd> or the Stop button. It pauses if you switch tabs or click into another
          field, stops if the page reloads, and never types into password or hidden fields. Chrome shows a "started debugging this browser" bar while it types;
          closing that bar stops typing too.
        </p>
      </div>
    );
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
        <ShieldCheck size={15} aria-hidden="true" /> Stops at once with <kbd>{stop}</kbd> or by moving the mouse to the top-left corner. Pauses if you click into
        another window, and never types into Typewriter itself or a password field it can detect.
      </p>
    </div>
  );
}

/** Output destination settings for the session settings panel. */
export function OutputSettings({ session }: { session: Session }) {
  const cid = useId();
  const running = session.snapshot.status === "playing" || session.snapshot.status === "paused";
  if (session.host === "web")
    return (
      <div className="settings__group">
        <h3 className="settings__heading">Output</h3>
        <p className="callout callout--info output-note">
          <MonitorSmartphone size={16} aria-hidden="true" className="callout__icon" />
          <span>This preview types inside Typewriter. To type into Google Docs or other apps, use the Typewriter Chrome extension or desktop app.</span>
        </p>
      </div>
    );
  const inChrome = session.host === "extension";
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
          inChrome
            ? { value: "external", label: "Into a web page", title: "Type into the page you click into, like Google Docs" }
            : { value: "external", label: "Into another app", title: "Type into the app you click into, like Google Docs" },
        ]}
      />
      {running ? <p className="field__hint">Change this after the current session ends.</p> : null}
      {session.destination === "external" ? (
        <>
          <div className={`permission permission--${support.available ? "ok" : "no"}`} data-testid="ext-support">
            {support.available ? <ShieldCheck size={15} aria-hidden="true" /> : <AlertTriangle size={15} aria-hidden="true" />}
            <span>{support.message}</span>
            {!support.available && support.state === "permission-denied" && support.platform !== "chrome" ? (
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
          {inChrome ? (
            <p className="field__hint" data-testid="permission-explainer">
              Typing into pages uses Chrome's debugger permission, the only way an extension can send real key presses (Google Docs ignores simulated ones).
              Typewriter uses it on one tab, only while typing, and only to type your text and check the focused field. It works in Chrome tabs only, not in
              other apps.
            </p>
          ) : null}
          <Field
            label="Countdown before typing"
            htmlFor={cid}
            hint={inChrome ? "Time to click the insertion point in the page." : "Time to click into your document after leaving Typewriter."}
          >
            <NumberInput
              id={cid}
              value={session.prefs.countdownSec}
              min={2}
              max={30}
              suffix="sec"
              onCommit={(countdownSec) => session.updatePrefs({ countdownSec })}
            />
          </Field>
          {!inChrome ? (
            <Switch
              checked={session.prefs.minimizeWhileTyping}
              onChange={(minimizeWhileTyping) => session.updatePrefs({ minimizeWhileTyping })}
              label="Minimise Typewriter while typing"
              description="Brings your document back to the front. A small status window stays on top."
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}
