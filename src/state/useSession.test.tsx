// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bridge, NativeUpdate, Support } from "../desktop/bridge";
import { DEFAULT_SETTINGS, type PlaybackSettings } from "../engine";
import { TypedBuffer } from "../engine/buffer";
import type { Step } from "../engine/script";
import type { Tone } from "../humanize";
import { NATURAL, ROBOTIC, ROBOTIC_HUMANIZED } from "../humanize/fixtures";
import type { Host } from "../platform";
import { DEFAULT_PREFS, useSession, type HistoryEntry } from "./useSession";

const env = vi.hoisted(() => ({ host: "web" as "web" | "desktop" | "extension", bridge: null as unknown, bridges: 0, brokenChecklist: false, humanizeCalls: [] as string[] }));

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
// The real Smart Humanization engine, recording what it was asked to check and, when a test asks, with a checklist that crashes.
vi.mock("../humanize", async (orig) => {
  const m = await orig<typeof import("../humanize")>();
  return {
    ...m,
    humanize: (source: string, tone: Tone) => {
      env.humanizeCalls.push(source);
      if (!env.brokenChecklist) return m.humanize(source, tone);
      const crash = () => {
        throw new Error("checklist crashed");
      };
      return m.humanize(source, tone, { runChecks: crash, rewrite: m.rewrite });
    },
  };
});
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
  env.brokenChecklist = false;
  env.humanizeCalls = [];
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

describe("useSession: Smart Humanization", () => {
  /** Plays the current text in the preview to the end and returns exactly what was typed. */
  function typeIt(result: { current: ReturnType<typeof useSession> }): string {
    let ok = false;
    act(() => void (ok = result.current.start()));
    expect(ok).toBe(true);
    advance(120_000);
    expect(result.current.snapshot.status).toBe("completed");
    return result.current.controller.buffer.text();
  }
  const on = (result: { current: ReturnType<typeof useSession> }) => act(() => void result.current.humanize.setEnabled(true));

  it("is off by default: nothing is checked and the original is typed exactly", () => {
    const { result } = setup();
    act(() => result.current.setText(ROBOTIC));
    expect(result.current.prefs.smartHumanize).toBe(false);
    expect(result.current.humanize).toMatchObject({ enabled: false, checking: false, result: null, usingOriginal: false, prepared: ROBOTIC });
    expect(env.humanizeCalls).toEqual([]);
    expect(typeIt(result)).toBe(ROBOTIC);
    expect(result.current.controller.getSource()).toBe(ROBOTIC);
  });

  it("turned on, checks pasted text automatically and types the humanized copy exactly; the original is kept", () => {
    const { result } = setup();
    on(result);
    expect(result.current.prefs.smartHumanize).toBe(true);
    expect(JSON.parse(localStorage.getItem("typewriter:prefs")!).smartHumanize).toBe(true);
    act(() => result.current.setText(ROBOTIC));
    const h = result.current.humanize;
    expect(h.result).toMatchObject({ status: "humanized", source: ROBOTIC, output: ROBOTIC_HUMANIZED });
    expect(h.result!.score!).toBeGreaterThanOrEqual(50);
    expect(h.prepared).toBe(ROBOTIC_HUMANIZED);
    // No approval step: the prepared copy is already what the preview holds.
    expect(result.current.snapshot.status).toBe("ready");
    expect(result.current.controller.getSource()).toBe(ROBOTIC_HUMANIZED);
    // The plan (duration, stats of what is typed) follows the copy that is typed.
    expect(result.current.script.source).toBe(ROBOTIC_HUMANIZED);

    expect(typeIt(result)).toBe(ROBOTIC_HUMANIZED);
    expect(result.current.text).toBe(ROBOTIC);
    expect(result.current.history[0].characters).toBe([...ROBOTIC_HUMANIZED].length);
  });

  it("leaves text that scores below 50% unchanged", () => {
    const { result } = setup();
    on(result);
    act(() => result.current.setText(NATURAL));
    expect(result.current.humanize.result).toMatchObject({ status: "no-change-needed" });
    expect(result.current.humanize.result!.score!).toBeLessThan(50);
    expect(result.current.humanize.prepared).toBe(NATURAL);
    expect(typeIt(result)).toBe(NATURAL);
  });

  it("leaves short text unchanged without a score", () => {
    const { result } = setup();
    on(result);
    const short = "Moreover, we utilize it. Furthermore, numerous things.";
    act(() => result.current.setText(short));
    expect(result.current.humanize.result).toMatchObject({ status: "too-short", score: null });
    expect(typeIt(result)).toBe(short);
  });

  it("turning it off restores exact-source typing", () => {
    const { result } = setup();
    on(result);
    act(() => result.current.setText(ROBOTIC));
    expect(result.current.controller.getSource()).toBe(ROBOTIC_HUMANIZED);
    act(() => void result.current.humanize.setEnabled(false));
    expect(result.current.humanize).toMatchObject({ enabled: false, result: null, prepared: ROBOTIC });
    expect(result.current.controller.getSource()).toBe(ROBOTIC);
    expect(typeIt(result)).toBe(ROBOTIC);
  });

  it("can type the original instead, and goes back to the humanized copy on request or when the text changes", () => {
    const { result } = setup();
    on(result);
    act(() => result.current.setText(ROBOTIC));
    act(() => void result.current.humanize.typeOriginal());
    expect(result.current.humanize).toMatchObject({ usingOriginal: true, prepared: ROBOTIC });
    expect(result.current.humanize.result!.output).toBe(ROBOTIC_HUMANIZED); // both versions are kept
    expect(typeIt(result)).toBe(ROBOTIC);

    act(() => void result.current.humanize.typeHumanized());
    expect(result.current.humanize).toMatchObject({ usingOriginal: false, prepared: ROBOTIC_HUMANIZED });
    expect(typeIt(result)).toBe(ROBOTIC_HUMANIZED);

    act(() => void result.current.humanize.typeOriginal());
    const edited = ROBOTIC + " Moreover, schools utilize tablets.";
    act(() => result.current.setText(edited));
    expect(result.current.humanize.usingOriginal).toBe(false);
    expect(result.current.humanize.result!.source).toBe(edited);
    expect(result.current.humanize.prepared).toBe(ROBOTIC_HUMANIZED + " Schools use tablets.");

    // Editing away and back again is a new text: the earlier choice doesn't come back.
    act(() => result.current.setText(ROBOTIC));
    act(() => void result.current.humanize.typeOriginal());
    act(() => result.current.setText(NATURAL));
    act(() => result.current.setText(ROBOTIC));
    expect(result.current.humanize).toMatchObject({ usingOriginal: false, prepared: ROBOTIC_HUMANIZED });
  });

  it("re-checks when the text or tone changes, always from the original, never from its own output", () => {
    const { result } = setup();
    on(result);
    act(() => result.current.setText(ROBOTIC));
    typeIt(result);
    typeIt(result);
    act(() => void result.current.restart());
    advance(120_000);
    expect(result.current.controller.buffer.text()).toBe(ROBOTIC_HUMANIZED);
    // Every check ran on the user's original; the rewrite was never fed back in.
    const checked = env.humanizeCalls.filter((s) => s !== ""); // the empty editor is checked once on mount
    expect(checked.length).toBeGreaterThan(0);
    expect(checked.every((s) => s === ROBOTIC)).toBe(true);
    expect(env.humanizeCalls).not.toContain(ROBOTIC_HUMANIZED);
    expect(result.current.text).toBe(ROBOTIC);

    act(() => void result.current.humanize.setTone("formal"));
    expect(result.current.prefs.humanizeTone).toBe("formal");
    expect(result.current.humanize.tone).toBe("formal");
    // A formal tone keeps formal wording, so the copy differs from the "any" copy but still comes from the original.
    expect(result.current.humanize.result!.source).toBe(ROBOTIC);
    expect(result.current.humanize.prepared).not.toBe(ROBOTIC_HUMANIZED);
    expect(result.current.humanize.prepared).toContain("utilize");
  });

  it("checks very long text after the editing pause, and a start in between still checks the latest text first", () => {
    const { result } = setup();
    on(result);
    const long = (ROBOTIC + "\n\n").repeat(40); // over the 20,000 characters that wait for a pause
    act(() => result.current.setText(long));
    expect(result.current.humanize.checking).toBe(true);
    advance(350);
    expect(result.current.humanize.checking).toBe(false);
    expect(result.current.humanize.result!.status).toBe("humanized");

    const longer = long + "Moreover, we utilize it in order to learn.";
    act(() => result.current.setText(longer));
    expect(result.current.humanize.checking).toBe(true);
    act(() => void result.current.start());
    const typed = result.current.controller.getSource();
    expect(typed).not.toBe(longer);
    expect(typed).toMatch(/[Ww]e use it to learn\.$/);
    act(() => void result.current.stop());
  });

  it("never changes the text mid-session: the toggle, tone and choice wait until the session ends", () => {
    const { result } = setup();
    on(result);
    act(() => result.current.setText(ROBOTIC));
    act(() => void result.current.start());
    expect(result.current.humanize.locked).toBe(true);
    advance(500);
    act(() => void result.current.humanize.setEnabled(false));
    act(() => void result.current.humanize.setTone("casual"));
    act(() => void result.current.humanize.typeOriginal());
    expect(result.current.humanize).toMatchObject({ enabled: true, tone: "any", usingOriginal: false });
    act(() => void result.current.pause());
    act(() => void result.current.humanize.setEnabled(false));
    expect(result.current.humanize.enabled).toBe(true);
    act(() => void result.current.resume());
    advance(120_000);
    expect(result.current.snapshot.status).toBe("completed");
    expect(result.current.controller.buffer.text()).toBe(ROBOTIC_HUMANIZED);
    expect(result.current.humanize.locked).toBe(false);
  });

  it("after a cancelled session, the toggle works and the next session types the right text", () => {
    const { result } = setup();
    on(result);
    act(() => result.current.setText(ROBOTIC));
    act(() => void result.current.start());
    advance(300);
    act(() => void result.current.stop());
    expect(result.current.snapshot.status).toBe("stopped");
    expect(result.current.text).toBe(ROBOTIC);
    act(() => void result.current.humanize.setEnabled(false));
    expect(result.current.humanize.enabled).toBe(false);
    expect(typeIt(result)).toBe(ROBOTIC);
  });

  it("when the checklist fails, says why and types the original exactly", () => {
    env.brokenChecklist = true;
    const { result } = setup();
    on(result);
    act(() => result.current.setText(ROBOTIC));
    expect(result.current.humanize.result).toMatchObject({ status: "failed", error: "checklist crashed", output: ROBOTIC });
    expect(result.current.humanize.prepared).toBe(ROBOTIC);
    expect(typeIt(result)).toBe(ROBOTIC);
  });

  it("repairs saved preferences that are not valid", () => {
    localStorage.setItem("typewriter:prefs", JSON.stringify({ smartHumanize: "yes", humanizeTone: "pirate" }));
    const { result } = setup();
    expect(result.current.prefs).toMatchObject({ smartHumanize: false, humanizeTone: "any" });
    localStorage.setItem("typewriter:prefs", JSON.stringify({ smartHumanize: true, humanizeTone: "casual" }));
    cleanup();
    const again = setup();
    expect(again.result.current.humanize).toMatchObject({ enabled: true, tone: "casual" });
  });

  it("exposes the diff of what changed; reverting a change puts that wording back in exactly what is typed", () => {
    const { result } = setup();
    on(result);
    act(() => result.current.setText(ROBOTIC));
    const d = result.current.humanize.diff!;
    expect(d.original).toBe(ROBOTIC);
    expect(d.revised).toBe(ROBOTIC_HUMANIZED);
    expect(d.stats.changes).toBe(9);
    const util = d.changes.find((c) => c.before === "utilize")!;
    let ok = false;
    act(() => void (ok = result.current.humanize.setChangeReverted(util.id, true)));
    expect(ok).toBe(true);
    const mixed = ROBOTIC_HUMANIZED.replace("students use", "students utilize");
    expect(result.current.humanize.reverted.has(util.id)).toBe(true);
    expect(result.current.humanize.prepared).toBe(mixed);
    // The diff itself (original vs humanized copy) doesn't change; only what is typed does.
    expect(result.current.humanize.diff).toBe(d);
    expect(result.current.controller.getSource()).toBe(mixed);
    expect(typeIt(result)).toBe(mixed);

    // Undo the revert.
    act(() => void result.current.humanize.setChangeReverted(util.id, false));
    expect(result.current.humanize.prepared).toBe(ROBOTIC_HUMANIZED);
    // Reverting every change types the original exactly.
    for (const c of d.changes) act(() => void result.current.humanize.setChangeReverted(c.id, true));
    expect(result.current.humanize.prepared).toBe(ROBOTIC);
    expect(typeIt(result)).toBe(ROBOTIC);
    // An unknown change id is refused.
    act(() => void (ok = result.current.humanize.setChangeReverted(999, true)));
    expect(ok).toBe(false);
  });

  it("reverts are dropped when the text, tone or result changes, and while typing nothing can be reverted", () => {
    const { result } = setup();
    on(result);
    act(() => result.current.setText(ROBOTIC));
    const first = result.current.humanize.diff!.changes[0];
    act(() => void result.current.humanize.setChangeReverted(first.id, true));
    expect(result.current.humanize.reverted.size).toBe(1);
    act(() => result.current.setText(ROBOTIC + " "));
    expect(result.current.humanize.reverted.size).toBe(0);
    act(() => result.current.setText(ROBOTIC));
    act(() => void result.current.humanize.setChangeReverted(first.id, true));
    act(() => void result.current.humanize.setTone("casual"));
    expect(result.current.humanize.reverted.size).toBe(0);
    expect(result.current.humanize.prepared).toBe(result.current.humanize.result!.output);

    act(() => void result.current.start());
    let ok = true;
    act(() => void (ok = result.current.humanize.setChangeReverted(first.id, true)));
    expect(ok).toBe(false);
    act(() => void (ok = result.current.humanize.rerun()));
    expect(ok).toBe(false);
    expect(result.current.humanize.reverted.size).toBe(0);
    act(() => void result.current.stop());
  });

  it("re-run checks the original again from scratch: clears reverts and the original choice, never runs on the rewrite", () => {
    const { result } = setup();
    on(result);
    act(() => result.current.setText(ROBOTIC));
    const before = result.current.humanize.result;
    act(() => void result.current.humanize.setChangeReverted(0, true));
    act(() => void result.current.humanize.typeOriginal());
    env.humanizeCalls = [];
    let ok = false;
    act(() => void (ok = result.current.humanize.rerun()));
    expect(ok).toBe(true);
    expect(result.current.humanize.runs).toBe(1);
    expect(env.humanizeCalls).toEqual([ROBOTIC]);
    expect(result.current.humanize.result).not.toBe(before);
    expect(result.current.humanize.result!.output).toBe(ROBOTIC_HUMANIZED);
    expect(result.current.humanize).toMatchObject({ usingOriginal: false, prepared: ROBOTIC_HUMANIZED });
    expect(result.current.humanize.reverted.size).toBe(0);
  });

  it("no diff when nothing changed or the feature is off", () => {
    const { result } = setup();
    on(result);
    act(() => result.current.setText(NATURAL));
    expect(result.current.humanize.diff).toBeNull();
    let ok = true;
    act(() => void (ok = result.current.humanize.setChangeReverted(0, true)));
    expect(ok).toBe(false);
    act(() => void result.current.humanize.setEnabled(false));
    expect(result.current.humanize.diff).toBeNull();
  });

  it("sends the humanized copy, exactly, to another app", async () => {
    const f = fakeBridge();
    env.bridge = f.bridge;
    const { result } = setup("desktop");
    await flush();
    act(() => result.current.setDestination("external"));
    on(result);
    act(() => result.current.setText(ROBOTIC));
    act(() => void result.current.start());
    await flush();
    expect(f.bridge.start).toHaveBeenCalledTimes(1);
    const [events, , , source] = f.bridge.start.mock.calls[0];
    expect(source).toBe(ROBOTIC_HUMANIZED);
    // The key events, played in order, produce exactly the humanized copy.
    const replay = new TypedBuffer();
    for (const e of events as Step[]) replay.apply(e);
    expect(replay.text()).toBe(ROBOTIC_HUMANIZED);
    f.update({ phase: "completed", index: (events as unknown[]).length, elapsedMs: 1000 });
    expect(result.current.snapshot.status).toBe("completed");

    // Off again: the original goes out exactly.
    act(() => void result.current.humanize.setEnabled(false));
    act(() => void result.current.start());
    await flush();
    expect(f.bridge.start.mock.calls[1][3]).toBe(ROBOTIC);
  });
});
