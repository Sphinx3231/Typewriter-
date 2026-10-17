/// <reference types="chrome" />
/**
 * Bridge between the app and Chrome for "Type into a web page".
 * Same interface as the desktop bridge, so the app's output adapter is shared.
 */
import type { TypingEvent } from "../engine";
import type { Bridge, NativeUpdate, Support } from "../desktop/bridge";
import { chromeBrowser } from "./chromeBrowser";
import { ChromeTypingSession } from "./session";

export const STOP_MESSAGE = "typewriter:stop";
/** Port name for telling the service worker which tab is attached (it releases the tab if this page closes). */
export const SESSION_PORT = "typewriter:session";

/** The keyboard shortcut Chrome actually assigned to "Stop typing" (users can change it). */
export async function stopShortcut(): Promise<string> {
  try {
    const cmds = await chrome.commands.getAll();
    return cmds.find((c) => c.name === "stop-typing")?.shortcut || "";
  } catch {
    return "";
  }
}

export async function hasDebuggerPermission(): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ permissions: ["debugger"] });
  } catch {
    return false;
  }
}

/**
 * Shown if Chrome somehow didn't grant "debugger". It is a required permission (Chrome doesn't
 * allow it to be optional), so this only happens with an outdated or damaged install.
 */
const MISSING_DEBUGGER: Support = {
  available: false,
  state: "permission-denied",
  platform: "chrome",
  message:
    'Chrome hasn\'t given Typewriter its "debugger" permission, so it can\'t type into pages. Nothing was typed. ' +
    "Open chrome://extensions, remove Typewriter, then load the dist-extension folder again with Load unpacked.",
};

export function extensionBridge(): Bridge {
  const listeners = new Set<(u: NativeUpdate) => void>();
  let session: ChromeTypingSession | null = null;

  // Keep the service worker informed of the attached tab. If this page closes mid-session,
  // the port disconnects and the worker detaches the debugger, so nothing is left attached.
  let port: chrome.runtime.Port | null = null;
  let attachedTab: number | null = null;
  const report = (tabId: number | null) => {
    attachedTab = tabId;
    if (!port && tabId === null) return;
    if (!port) {
      port = chrome.runtime.connect({ name: SESSION_PORT });
      port.onDisconnect.addListener(() => {
        port = null; // the worker restarted; reconnect and report again
        if (attachedTab !== null) report(attachedTab);
      });
    }
    port.postMessage({ tabId });
  };

  // Emergency stop from the keyboard shortcut (relayed by the service worker).
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === STOP_MESSAGE) session?.send("stop");
  });
  // Closing the panel or tab ends the session; the debugger detaches with it.
  addEventListener("pagehide", () => session?.send("stop"));

  return {
    async support(): Promise<Support> {
      return (await hasDebuggerPermission())
        ? { available: true, state: "ok", platform: "chrome", message: "Ready to type into web pages in this window." }
        : MISSING_DEBUGGER;
    },
    async start(events: TypingEvent[], countdownMs: number, _minimize: boolean, source = "", token?: number) {
      if (!(await hasDebuggerPermission())) throw JSON.stringify(MISSING_DEBUGGER);
      session?.send("stop");
      const s = new ChromeTypingSession(chromeBrowser(report), events, { countdownMs, resumeCountdownMs: 3000, source }, (u) => listeners.forEach((fn) => fn({ ...u, session: token } as NativeUpdate)));
      session = s;
      void s.run().finally(() => {
        if (session === s) session = null;
      });
      return { shortcutRegistered: (await stopShortcut()) !== "" };
    },
    async control(command) {
      if (!session) throw new Error("No typing session is running.");
      session.send(command);
    },
    async readClipboard() {
      const ok = await chrome.permissions.request({ permissions: ["clipboardRead"] }).catch(() => false);
      if (!ok) return "";
      return navigator.clipboard.readText();
    },
    async showMain() {},
    onUpdate(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
