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

export function extensionBridge(): Bridge {
  const listeners = new Set<(u: NativeUpdate) => void>();
  let session: ChromeTypingSession | null = null;

  // Emergency stop from the keyboard shortcut (relayed by the service worker).
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === STOP_MESSAGE) session?.send("stop");
  });
  // Closing the panel or tab ends the session; the debugger detaches with it.
  addEventListener("pagehide", () => session?.send("stop"));

  return {
    async support(prompt: boolean): Promise<Support> {
      let granted = await hasDebuggerPermission();
      if (!granted && prompt) granted = await chrome.permissions.request({ permissions: ["debugger"] }).catch(() => false);
      return granted
        ? { available: true, state: "ok", platform: "chrome", message: "Ready to type into web pages in this window." }
        : {
            available: true,
            state: "ok",
            platform: "chrome",
            message: "Chrome will ask once for permission to control a tab's typing when you start.",
          };
    },
    async start(events: TypingEvent[], countdownMs: number, _minimize: boolean, source = "") {
      // Must run in the click that started it: Chrome only shows permission prompts for user gestures.
      const granted = (await hasDebuggerPermission()) || (await chrome.permissions.request({ permissions: ["debugger"] }).catch(() => false));
      if (!granted) {
        const s: Support = {
          available: false,
          state: "permission-denied",
          platform: "chrome",
          message: "Typing into pages needs the \"debugger\" permission, and it wasn't granted. Nothing was typed. Start again and choose Allow.",
        };
        throw JSON.stringify(s);
      }
      session?.send("stop");
      const s = new ChromeTypingSession(chromeBrowser(), events, { countdownMs, resumeCountdownMs: 3000, source }, (u) => listeners.forEach((fn) => fn(u as NativeUpdate)));
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
