// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bridge, NativeUpdate, Support } from "../desktop/bridge";
import { DEFAULT_SETTINGS, type PlaybackSettings } from "../engine";
import type { Host } from "../platform";
import { DEFAULT_PREFS, useSession, type HistoryEntry } from "./useSession";

const env = vi.hoisted(() => ({ host: "web" as "web" | "desktop" | "extension", bridge: null as unknown, bridges: 0 }));

vi.mock("../platform", () => ({
  currentHost: () => env.host,
  isDesktop: () => env.host === "desktop",
  isExtension: () => env.host === "extension",
}));
vi.mock("../desktop/bridge", async (orig) => ({
  ...(await orig<typeof import("../desktop/bridge")>()),
  tauriBridge: async () => {
    env.bridges++;
    return env.bridge;
  },
}));
vi.mock("../extension/bridge", () => ({
  extensionBridge: () => {
    env.bridges++;
    return env.bridge;
  },
}));

const OK: Support = { available: true, state: "ok", platform: "linux", message: "Ready." };

/** A typing engine on the other side of the Bridge interface, driven by the test. */
function fakeBridge(support: Support = OK) {
  let push: (u: NativeUpdate) => void = () => {};
  let token: number | undefined;
  const bridge = {
    support: vi.fn(async (_prompt: boolean) => support),
    start: vi.fn(async (_events: unknown[], _countdownMs: number, _minimize: boolean, _source?: string, session?: number) => {
      token = session;
      return { shortcutRegistered: true };
    }),
    control: vi.fn(async (_c: "pause" | "resume" | "stop") => {}),
    readClipboard: vi.fn(async () => ""),
    showMain: vi.fn(async () => {}),
    onUpdate: (fn: (u: NativeUpdate) => void) => {
      push = fn;
      return () => {};
    },
  };
  const update = (u: Partial<NativeUpdate>) =>
    act(() => push({ phase: "typing", index: 0, elapsedMs: 0, totalMs: 0, countdownMs: 0, target: null, reason: null, message: null, session: token, ...u }));
  return { bridge: bridge satisfies Bridge, update };
}

const FAST: Partial<PlaybackSettings> = { timingMode: "speed", wpm: 400, rhythm: false, pauses: false, mistakes: "off", sound: false };
const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
const flush = () => act(async () => {});

function setup(host: Host = "web", settings: Partial<PlaybackSettings> = FAST) {
  env.host = host;
  localStorage.setItem("typewriter:settings", JSON.stringify(settings));
  return renderHook(() => useSession());
}

beforeEach(() => {
  localStorage.clear();
  env.host = "web";
  env.bridge = null;
  env.bridges = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useSession: defaults and persistence", () => {
  it("starts from defaults and never keeps the text unless asked", () => {
    const { result } = renderHook(() => useSession());
    expect(result.current.prefs).toEqual(DEFAULT_PREFS);
    expect(result.current.settings).toEqual(DEFAULT_SETTINGS);
    expect(result.current.text).toBe("");
    expect(result.current.blank).toBe(true);
    expect(result.current.history).toEqual([]);
    expect(result.current.snapshot.status).toBe("empty");
    expect(result.current.host).toBe("web");
    expect(result.current.desktop).toBe(false);
    expect(result.current.externalReady).toBe(false);
    expect(result.current.support.state).toBe("browser");
    expect(result.current.destination).toBe("preview");

    act(() => result.current.setText("secret"));
    advance(1000);
    expect(localStorage.getItem("typewriter:text")).toBeNull();
    expect(JSON.parse(localStorage.getItem("typewriter:prefs")!)).toEqual(DEFAULT_PREFS);
  });

  it("restores remembered text, saved preferences and history, and ignores a corrupt history", () => {
    localStorage.setItem("typewriter:prefs", JSON.stringify({ rememberText: true, volume: 0.2 }));
    localStorage.setItem("typewriter:text", "kept text");
    localStorage.setItem("typewriter:history", JSON.stringify({ not: "a list" }));
    const { result } = renderHook(() => useSession());
    expect(result.current.text).toBe("kept text");
    expect(result.current.prefs.volume).toBe(0.2);
    expect(result.current.prefs.keepHistory).toBe(true);
    expect(result.current.history).toEqual([]);
    expect(result.current.snapshot.status).toBe("ready");

    // Remembered text is saved after a short pause in typing.
    act(() => result.current.setText("new text"));
    advance(399);
    expect(localStorage.getItem("typewriter:text")).toBe("kept text");
    advance(1);
    expect(localStorage.getItem("typewriter:text")).toBe("new text");

    // Turning remembering off removes the stored copy at once.
    act(() => result.current.updatePrefs({ rememberText: false }));
    expect(localStorage.getItem("typewriter:text")).toBeNull();
  });

  it("starts empty when remembering is on but nothing was saved yet", () => {
    localStorage.setItem("typewriter:prefs", JSON.stringify({ rememberText: true }));
    const { result } = renderHook(() => useSession());
    expect(result.current.text).toBe("");
  });

  it("restores a valid history list", () => {
    const entry = { id: "a", status: "completed" } as HistoryEntry;
    localStorage.setItem("typewriter:history", JSON.stringify([entry]));
    const { result } = renderHook(() => useSession());
    expect(result.current.history).toEqual([entry]);
  });

  it("saves settings shortly after they change, and resets everything on request", () => {
    const { result } = renderHook(() => useSession());
    act(() => result.current.updateSettings({ wpm: 90 }));
    expect(result.current.settings.wpm).toBe(90);
    advance(250);
    expect(JSON.parse(localStorage.getItem("typewriter:settings")!).wpm).toBe(90);

    act(() => result.current.applyDuration(12.2));
    expect(result.current.settings).toMatchObject({ timingMode: "duration", durationSec: 13 });

    const seed = result.current.settings.seed;
    act(() => result.current.newVariation());
    expect(result.current.settings.seed).not.toBe(seed);

    act(() => result.current.updatePrefs({ volume: 0.1, keepHistory: false }));
    act(() => result.current.resetPreferences());
    expect(result.current.settings).toEqual(DEFAULT_SETTINGS);
    expect(result.current.prefs).toEqual(DEFAULT_PREFS);
  });
});

describe("useSession: planning", () => {
  it("plans the text, reports issues and offers speed/duration equivalents", () => {
    const { result } = setup();
    act(() => result.current.setText("One two three four five."));
    expect(result.current.stats.words).toBe(5);
    expect(result.current.planning).toBe(false);
    expect(result.current.estimate.totalMs).toBeGreaterThan(0);
    expect(result.current.equivalents.durationForWpm(60)).toBeGreaterThan(result.current.equivalents.durationForWpm(120));
    expect(result.current.equivalents.wpmForDuration(10)).toBeGreaterThan(0);
    expect(result.current.issues).toEqual([]);
    expect(result.current.snapshot.status).toBe("ready");

    // Invalid settings leave nothing to play.
    act(() => result.current.updateSettings({ wpm: 1 }));
    expect(result.current.issues[0].field).toBe("wpm");
    expect(result.current.snapshot.status).toBe("empty");
    let started = true;
    act(() => void (started = result.current.start()));
    expect(started).toBe(false);

    // Whitespace-only text is blank and can't start.
    act(() => result.current.updateSettings({ wpm: 120 }));
    act(() => result.current.setText("   \n "));
    expect(result.current.blank).toBe(true);
    act(() => void (started = result.current.start()));
    expect(started).toBe(false);
  });

  it("waits for a pause in editing before planning very long texts, and plans fresh if started meanwhile", () => {
    const { result } = setup();
    const long = "word ".repeat(5000);
    act(() => result.current.setText(long));
    expect(result.current.planning).toBe(true);
    expect(result.current.stats.words).toBe(0);
    advance(350);
    expect(result.current.planning).toBe(false);
    expect(result.current.stats.words).toBe(5000);

    // Edited and started before the new plan settled: the started session still uses the latest text.
    const longer = long + "end.";
    act(() => result.current.setText(longer));
    expect(result.current.planning).toBe(true);
    act(() => void result.current.start());
    expect(result.current.snapshot.status).toBe("playing");
    expect(result.current.controller.getSource()).toBe(longer);
    act(() => void result.current.stop());
  });
});

describe("useSession: preview playback", () => {
  it("plays, pauses, resumes and completes, then records the session (stats only)", () => {
    const { result } = setup();
    const text = "The quick brown fox jumps over the lazy dog.";
    act(() => result.current.setText(text));
    let ok = false;
    act(() => void (ok = result.current.start()));
    expect(ok).toBe(true);
    expect(result.current.snapshot.status).toBe("playing");

    // The editor is locked while playing.
    act(() => result.current.setText("other"));
    expect(result.current.text).toBe(text);
    // The destination can't change mid-session.
    act(() => result.current.setDestination("external"));
    expect(result.current.prefs.destination).toBe("preview");

    advance(100);
    act(() => void result.current.pause());
    expect(result.current.snapshot.status).toBe("paused");
    // Changing settings now is flagged until the next start.
    act(() => result.current.updateSettings({ wpm: 300 }));
    expect(result.current.settingsChangedSinceStart).toBe(true);
    act(() => void result.current.resume());
    expect(result.current.snapshot.status).toBe("playing");
    advance(30_000);
    expect(result.current.snapshot.status).toBe("completed");
    expect(result.current.controller.getSource()).toBe(text);

    expect(result.current.history).toHaveLength(1);
    const h = result.current.history[0];
    expect(h).toMatchObject({ status: "completed", characters: text.length, words: 9, destination: "preview", verification: undefined, mistakeLevel: "off" });
    expect(h.wpm).toBeGreaterThan(0);
    expect(JSON.stringify(h)).not.toContain("quick");
    expect(JSON.parse(localStorage.getItem("typewriter:history")!)).toHaveLength(1);

    // The finished output stays on screen when only settings change...
    act(() => result.current.updateSettings({ wpm: 200 }));
    expect(result.current.snapshot.status).toBe("completed");
    // ...and is replaced once the text changes.
    act(() => result.current.setText(text + " More."));
    expect(result.current.snapshot.status).toBe("ready");

    // No verification is possible for the preview.
    let verified: unknown = "x";
    return act(async () => {
      verified = await result.current.verifyDestination();
    }).then(() => {
      expect(verified).toBeNull();
      expect(result.current.showMain()).toBeUndefined();
    });
  });

  it("restarts a running session from the beginning and records a stop with no elapsed time", () => {
    const { result } = setup();
    act(() => result.current.setText("Some text to type for a while, then stop."));
    act(() => void result.current.start());
    advance(200);
    expect(result.current.snapshot.eventIndex).toBeGreaterThan(0);
    let ok = false;
    act(() => void (ok = result.current.restart()));
    expect(ok).toBe(true);
    expect(result.current.snapshot.status).toBe("playing");
    expect(result.current.snapshot.eventIndex).toBe(0);
    // Starting again while playing stops the running session first.
    act(() => void result.current.start());
    act(() => void result.current.stop());
    expect(result.current.snapshot.status).toBe("stopped");
    expect(result.current.history[0]).toMatchObject({ status: "stopped", wpm: 0, elapsedMs: 0 });

    act(() => void result.current.reset());
    expect(result.current.snapshot.status).toBe("ready");

    act(() => result.current.deleteHistoryEntry(result.current.history[0].id));
    expect(result.current.history).toHaveLength(0);
  });

  it("does not record history when it is turned off, and can clear it", () => {
    localStorage.setItem("typewriter:history", JSON.stringify([{ id: "old" }]));
    const { result } = setup();
    act(() => result.current.updatePrefs({ keepHistory: false }));
    act(() => result.current.setText("abc"));
    act(() => void result.current.start());
    advance(5000);
    expect(result.current.snapshot.status).toBe("completed");
    expect(result.current.history).toHaveLength(1);
    act(() => result.current.clearHistory());
    expect(result.current.history).toEqual([]);
  });

  it("plays typing sounds when sound is on", () => {
    const { result } = setup("web", { ...FAST, sound: true });
    act(() => result.current.setText("abc"));
    act(() => void result.current.start());
    advance(5000);
    expect(result.current.snapshot.status).toBe("completed");
  });
});

describe("useSession: typing into another app", () => {
  it("connects to the desktop engine, arms typing and mirrors its progress", async () => {
    const f = fakeBridge();
    env.bridge = f.bridge;
    const { result } = setup("desktop");
    expect(result.current.desktop).toBe(true);
    expect(result.current.support.message).toBe("Checking…");
    await flush();
    expect(result.current.externalReady).toBe(true);
    expect(result.current.support).toEqual(OK);
    expect(f.bridge.support).toHaveBeenCalledWith(false);

    act(() => result.current.setDestination("external"));
    expect(result.current.destination).toBe("external");
    const text = "Hello app.";
    act(() => result.current.setText(text));
    expect(result.current.snapshot.status).toBe("ready");
    act(() => result.current.updatePrefs({ countdownSec: 3, minimizeWhileTyping: false }));

    act(() => void result.current.start());
    await flush();
    expect(f.bridge.start).toHaveBeenCalledTimes(1);
    expect(f.bridge.start.mock.calls[0].slice(1, 4)).toEqual([3000, false, text]);
    expect(result.current.snapshot.external?.phase).toBe("preparing");

    const n = result.current.controller.getTimeline()!.events.length;
    f.update({ phase: "countdown", countdownMs: 2000 });
    expect(result.current.snapshot.external?.phase).toBe("countdown");
    f.update({ phase: "typing", index: 3, elapsedMs: 100 });
    expect(result.current.snapshot.eventIndex).toBe(3);
    act(() => void result.current.pause());
    expect(f.bridge.control).toHaveBeenLastCalledWith("pause");
    f.update({ phase: "paused", index: 3, elapsedMs: 100 });
    expect(result.current.snapshot.status).toBe("paused");
    act(() => void result.current.resume());
    expect(f.bridge.control).toHaveBeenLastCalledWith("resume");
    f.update({ phase: "completed", index: n, elapsedMs: 1000 });
    expect(result.current.snapshot.status).toBe("completed");

    // Recorded as sent, not verified.
    expect(result.current.history[0]).toMatchObject({ destination: "external", verification: "sent" });
    // Restarting would duplicate what's already in the document.
    let ok = true;
    act(() => void (ok = result.current.restart()));
    expect(ok).toBe(false);

    // An empty clipboard changes nothing.
    let r = await act(() => result.current.verifyDestination());
    expect(r?.status).toBe("empty");
    expect(result.current.history[0].verification).toBe("sent");
    // A copy that differs marks the session as a mismatch...
    f.bridge.readClipboard.mockResolvedValueOnce("Hello ap");
    r = await act(() => result.current.verifyDestination());
    expect(r?.status).toBe("mismatch");
    expect(result.current.history[0].verification).toBe("mismatch");
    // ...and an exact copy verifies it.
    f.bridge.readClipboard.mockResolvedValueOnce(text);
    r = await act(() => result.current.verifyDestination());
    expect(r?.status).toBe("verified");
    expect(result.current.history[0].verification).toBe("verified");

    await act(async () => void (await result.current.showMain()));
    expect(f.bridge.showMain).toHaveBeenCalled();

    // Back to the preview once the session is over.
    act(() => result.current.setDestination("preview"));
    expect(result.current.destination).toBe("preview");
    expect(result.current.snapshot.status).toBe("ready");
  });

  it("marks only the latest session when the copied text is checked", async () => {
    const f = fakeBridge();
    env.bridge = f.bridge;
    const older = { id: "older", status: "completed", destination: "external", verification: "sent" } as HistoryEntry;
    localStorage.setItem("typewriter:history", JSON.stringify([older]));
    localStorage.setItem("typewriter:prefs", JSON.stringify({ destination: "external" }));
    const { result } = setup("desktop");
    await flush();
    act(() => result.current.setText("Ok."));
    act(() => void result.current.start());
    await flush();
    f.update({ phase: "completed", index: result.current.controller.getTimeline()!.events.length, elapsedMs: 500 });
    expect(result.current.history).toHaveLength(2);
    f.bridge.readClipboard.mockResolvedValueOnce("Ok.");
    await act(() => result.current.verifyDestination());
    expect(result.current.history[0].verification).toBe("verified");
    expect(result.current.history[1]).toEqual(older);
  });

  it("verifies before any session was recorded without touching history", async () => {
    const f = fakeBridge();
    f.bridge.readClipboard.mockResolvedValue("x");
    env.bridge = f.bridge;
    const { result } = setup("desktop");
    await flush();
    const r = await act(() => result.current.verifyDestination());
    expect(r?.status).toBe("mismatch");
    expect(result.current.history).toEqual([]);
  });

  it("re-checks support, prompting for access when asked", async () => {
    const denied: Support = { available: false, state: "permission-denied", platform: "macos", message: "Allow access." };
    const f = fakeBridge(denied);
    env.bridge = f.bridge;
    const { result } = setup("desktop");
    await flush();
    expect(result.current.support).toEqual(denied);
    f.bridge.support.mockResolvedValueOnce(OK);
    await act(() => result.current.refreshSupport(true));
    expect(f.bridge.support).toHaveBeenLastCalledWith(true);
    expect(result.current.support).toEqual(OK);
    await act(() => result.current.refreshSupport());
    expect(f.bridge.support).toHaveBeenLastCalledWith(false);
  });

  it("does nothing when re-checking support in a plain browser", async () => {
    const { result } = setup("web");
    const before = result.current.support;
    await act(() => result.current.refreshSupport(true));
    expect(result.current.support).toBe(before);
  });

  it("uses the Chrome extension bridge inside the extension", async () => {
    const f = fakeBridge();
    env.bridge = f.bridge;
    const { result } = setup("extension");
    expect(result.current.host).toBe("extension");
    expect(result.current.desktop).toBe(false);
    await flush();
    expect(env.bridges).toBe(1);
    expect(result.current.externalReady).toBe(true);
  });

  it("ignores a bridge that connects after the app closed", async () => {
    const f = fakeBridge();
    env.bridge = f.bridge;
    const { unmount } = setup("desktop");
    unmount();
    await flush();
    expect(f.bridge.support).not.toHaveBeenCalled();
  });

  it("starts with the default countdown and minimise options when they were never changed", async () => {
    const f = fakeBridge();
    env.bridge = f.bridge;
    localStorage.setItem("typewriter:prefs", JSON.stringify({ destination: "external" }));
    const { result } = setup("desktop");
    await flush();
    act(() => result.current.setText("Hi."));
    act(() => void result.current.start());
    await flush();
    expect(f.bridge.start.mock.calls[0].slice(1, 3)).toEqual([5000, true]);
    // Stopping before the engine typed anything settles at once.
    act(() => void result.current.stop());
    expect(result.current.snapshot.status).toBe("stopped");
    expect(f.bridge.control).toHaveBeenCalledWith("stop");
  });
});
