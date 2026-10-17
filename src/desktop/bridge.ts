/**
 * Bridge to the desktop shell (Tauri). In a plain browser none of this exists,
 * and `isDesktop()` is false; the app then offers the in-app preview only.
 */
import type { TypingEvent } from "../engine";

export interface NativeUpdate {
  phase: "preparing" | "waiting" | "countdown" | "typing" | "paused" | "resuming" | "completed" | "stopped" | "failed";
  index: number;
  elapsedMs: number;
  totalMs: number;
  countdownMs: number;
  target: { windowId: string; processId: number; appName: string; title: string } | null;
  reason: string | null;
  message: string | null;
  /** Desktop: whether the emergency-stop shortcut is registered right now. */
  shortcutRegistered?: boolean;
  /** Read-back result, when the destination could be inspected (browser extension). */
  verification?: { status: "verified" | "mismatch" | "unreadable"; detail: string };
}

export interface Support {
  available: boolean;
  state: "ok" | "permission-denied" | "no-display" | "wayland" | "unsupported" | "browser";
  platform: string;
  message: string;
}

export interface Bridge {
  support(prompt: boolean): Promise<Support>;
  start(events: TypingEvent[], countdownMs: number, minimize: boolean, source?: string): Promise<{ shortcutRegistered: boolean }>;
  control(command: "pause" | "resume" | "stop"): Promise<void>;
  readClipboard(): Promise<string>;
  onUpdate(fn: (u: NativeUpdate) => void): () => void;
  /** The running session's latest status, if any (desktop: for a status window that opens late). */
  state?(): Promise<NativeUpdate | null>;
  showMain(): Promise<void>;
}

export { isDesktop } from "../platform";

/** Only the fields the native side reads; keeps the payload small. */
function slim(events: TypingEvent[]) {
  return events.map(({ kind, at, text, to, start, end, replacement }) => ({ kind, at, text, to, start, end, replacement }));
}

export async function tauriBridge(): Promise<Bridge> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  return {
    support: (prompt) => invoke<Support>("external_support", { prompt }),
    start: (events, countdownMs, minimize) => invoke("external_start", { events: slim(events), countdownMs, minimize }),
    control: (command) => invoke("external_control", { command }),
    readClipboard: () => invoke<string>("read_clipboard"),
    showMain: () => invoke("show_main"),
    state: () => invoke<NativeUpdate | null>("external_state"),
    onUpdate(fn) {
      let off: (() => void) | null = null;
      let cancelled = false;
      void listen<NativeUpdate>("external://update", (e) => fn(e.payload)).then((u) => {
        if (cancelled) u();
        else off = u;
      });
      return () => {
        cancelled = true;
        off?.();
      };
    },
  };
}

/** Parses the structured error the native side returns when typing can't start. */
export function parseSupportError(err: unknown): Support | null {
  const text = typeof err === "string" ? err : err instanceof Error ? err.message : "";
  try {
    const v = JSON.parse(text) as Support;
    return typeof v?.message === "string" ? v : null;
  } catch {
    return null;
  }
}
