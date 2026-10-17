import { afterEach, describe, expect, it, vi } from "vitest";
import { browserClock, PlaybackController, type PlaybackStatus } from "./player";
import { buildTimeline, type Timeline, type TypingEvent } from "./schedule";
import { buildScript, type Script, type Step } from "./script";
import { DEFAULT_SETTINGS } from "./settings";
import { FakeClock } from "./testing";

// Clean typing: every character costs exactly one unit. At 60 WPM a unit is 200 ms,
// so character k (1-based) lands at k * 200 ms.
const CLEAN = { ...DEFAULT_SETTINGS, rhythm: false, pauses: false, mistakes: "off" as const };
const timelineFor = (text: string): Timeline => buildTimeline(buildScript(text, CLEAN), { timingMode: "speed", durationSec: 0, wpm: 60 });

/** A timeline built from hand-written steps (each one unit long). */
function timelineFromSteps(source: string, steps: Partial<Step>[]): Timeline {
  const full: Step[] = steps.map((s, i) => ({ kind: "type", u: 1, p: 0, ms: 0, fix: false, src: i + 1, ...s }));
  const script: Script = {
    source,
    graphemes: [...source],
    steps: full,
    keyUnits: full.length,
    pauseUnits: 0,
    fixUnits: 0,
    fixedMs: 0,
    mistakes: 0,
  };
  return buildTimeline(script, { timingMode: "speed", durationSec: 0, wpm: 60 });
}

const TEXT = "abcdefgh"; // 8 events, 1600 ms

function setup(text = TEXT) {
  const clock = new FakeClock();
  const p = new PlaybackController(clock);
  const tl = timelineFor(text);
  p.load(text, tl);
  return { clock, p, tl };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("browserClock", () => {
  it("reads the monotonic performance clock", () => {
    vi.spyOn(performance, "now").mockReturnValue(1234.5);
    expect(browserClock.now()).toBe(1234.5);
  });

  it("schedules and cancels real timers", () => {
    vi.useFakeTimers();
    const fired = vi.fn();
    const cancelled = vi.fn();
    browserClock.setTimeout(fired, 50);
    const h = browserClock.setTimeout(cancelled, 50);
    browserClock.clearTimeout(h);
    vi.advanceTimersByTime(49);
    expect(fired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fired).toHaveBeenCalledTimes(1);
    expect(cancelled).not.toHaveBeenCalled();
  });

  it("coalesces UI work on animation frames when the browser has them", () => {
    const raf = vi.fn((cb: FrameRequestCallback) => {
      cb(16.7);
      return 1;
    });
    vi.stubGlobal("requestAnimationFrame", raf);
    const fn = vi.fn();
    browserClock.frame(fn);
    expect(raf).toHaveBeenCalledTimes(1);
    // The frame timestamp is not forwarded to the callback.
    expect(fn).toHaveBeenCalledWith();
  });

  it("falls back to a ~16 ms timer without requestAnimationFrame", () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", undefined);
    const fn = vi.fn();
    browserClock.frame(fn);
    vi.advanceTimersByTime(15);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("PlaybackController accessors", () => {
  it("has no session before load", () => {
    const p = new PlaybackController(new FakeClock());
    expect(p.getStatus()).toBe("empty");
    expect(p.getTimeline()).toBeNull();
    expect(p.getSource()).toBe("");
    expect(p.getElapsed()).toBe(0);
    expect(p.canRestart).toBe(true);
    const snap = p.getSnapshot();
    expect(snap).toMatchObject({ status: "empty", totalMs: 0, progress: 0, eventCount: 0, sourceDone: 0, sourceTotal: 0, currentWpm: 0, error: null });
  });

  it("exposes the loaded source and timeline", () => {
    const { p, tl } = setup();
    expect(p.getSource()).toBe(TEXT);
    expect(p.getTimeline()).toBe(tl);
    expect(p.getSnapshot()).toMatchObject({ status: "ready", totalMs: 1600, eventCount: 8, sourceTotal: 8 });
  });

  it("getElapsed follows the clock while playing, freezes on pause and caps at the total", () => {
    const { clock, p } = setup();
    p.start();
    clock.advance(700);
    expect(p.getElapsed()).toBe(700);
    p.pause();
    clock.advance(5000);
    expect(p.getElapsed()).toBe(700);
    p.resume();
    clock.advance(5000);
    expect(p.getStatus()).toBe("completed");
    expect(p.getElapsed()).toBe(1600);
  });
});

describe("PlaybackController subscriptions", () => {
  it("notifies subscribers immediately on state changes and stops after unsubscribe", () => {
    const clock = new FakeClock();
    const p = new PlaybackController(clock);
    const fn = vi.fn();
    const off = p.subscribe(fn);
    p.load(TEXT, timelineFor(TEXT));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(p.getSnapshot().status).toBe("ready");
    off();
    p.start();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(p.getSnapshot().status).toBe("playing");
  });

  it("coalesces per-keystroke notifications into one per frame", () => {
    const { clock, p } = setup();
    const fn = vi.fn();
    p.subscribe(fn);
    p.start();
    expect(fn).toHaveBeenCalledTimes(1); // ready → playing
    clock.advance(1000); // five keystrokes at 200..1000 ms, one frame flush
    expect(fn).toHaveBeenCalledTimes(2);
    expect(p.getSnapshot().eventIndex).toBe(5);
    expect(p.getSnapshot().sourceDone).toBe(5);
    expect(p.buffer.text()).toBe("abcde");
  });

  it("sends each on-time keystroke to keystroke listeners, in order", () => {
    const { clock, p } = setup();
    const seen: TypingEvent[] = [];
    const off = p.onKeystroke((e) => seen.push(e));
    p.start();
    clock.advance(1000);
    expect(seen.map((e) => e.text).join("")).toBe("abcde");
    off();
    clock.advance(1000);
    expect(seen).toHaveLength(5);
    expect(p.buffer.text()).toBe(TEXT);
  });

  it("does not sound keystrokes applied late while catching up after a stall", () => {
    const { clock, p } = setup();
    const heard = vi.fn();
    p.onKeystroke(heard);
    p.start();
    // The first tick fires 4.8 s late: every event is already overdue by more than 120 ms.
    clock.advance(5000, 4800);
    expect(p.getStatus()).toBe("completed");
    expect(p.buffer.text()).toBe(TEXT);
    expect(heard).not.toHaveBeenCalled();
  });

  it("dispose cancels the pending tick and drops all listeners", () => {
    const { clock, p } = setup();
    const fn = vi.fn();
    const key = vi.fn();
    p.subscribe(fn);
    p.onKeystroke(key);
    p.start();
    clock.advance(400);
    expect(p.buffer.text()).toBe("ab");
    fn.mockClear();
    key.mockClear();
    p.dispose();
    expect(clock.pending).toBe(0);
    clock.advance(5000);
    expect(p.buffer.text()).toBe("ab");
    expect(p.stop()).toBe(true);
    expect(fn).not.toHaveBeenCalled();
    expect(key).not.toHaveBeenCalled();
  });
});

describe("PlaybackController commands", () => {
  it("restart is refused without a playable timeline", () => {
    const p = new PlaybackController(new FakeClock());
    expect(p.restart()).toBe(false);
    p.load("", null);
    expect(p.getStatus()).toBe("empty");
    expect(p.restart()).toBe(false);
    expect(p.start()).toBe(false);
  });

  it("reset returns paused, completed and stopped sessions to ready with a cleared buffer", () => {
    const { clock, p } = setup();
    expect(p.reset()).toBe(false); // ready: nothing to reset

    p.start();
    clock.advance(500);
    p.pause();
    expect(p.reset()).toBe(true);
    expect(p.getStatus()).toBe("ready");
    expect(p.buffer.text()).toBe("");
    expect(p.getSnapshot().elapsedMs).toBe(0);

    p.start();
    clock.advance(2000);
    expect(p.getStatus()).toBe("completed");
    expect(p.reset()).toBe(true);
    expect(p.getStatus()).toBe("ready");
    expect(p.buffer.text()).toBe("");

    p.start();
    clock.advance(300);
    p.stop();
    expect(p.reset()).toBe(true);
    expect(p.getStatus()).toBe("ready");
  });

  it("stopping from pause keeps the paused position", () => {
    const { clock, p } = setup();
    p.start();
    clock.advance(650);
    p.pause();
    clock.advance(1000);
    expect(p.stop()).toBe(true);
    expect(p.getStatus()).toBe("stopped");
    expect(p.getSnapshot().elapsedMs).toBe(650);
    expect(p.buffer.text()).toBe("abc");
  });

  it("can load a new session after completion", () => {
    const { clock, p } = setup();
    p.start();
    clock.advance(2000);
    expect(p.load("xy", timelineFor("xy"))).toBe(true);
    expect(p.getStatus()).toBe("ready");
    expect(p.buffer.text()).toBe("");
    p.start();
    clock.advance(400);
    expect(p.getStatus()).toBe("completed");
    expect(p.buffer.text()).toBe("xy");
  });

  it("guards its state machine against transitions the table forbids", () => {
    const p = new PlaybackController(new FakeClock());
    const internal = p as unknown as { setStatus(to: PlaybackStatus): void };
    expect(() => internal.setStatus("playing")).toThrow("Invalid playback transition empty → playing");
    expect(p.getStatus()).toBe("empty");
    // Staying in the same state is always allowed.
    expect(() => internal.setStatus("empty")).not.toThrow();
  });
});

describe("PlaybackController timing robustness", () => {
  it("ignores a stale tick from a cancelled timer (no double typing)", () => {
    // A clock whose clearTimeout does nothing: cancelled callbacks still fire, as can
    // happen when a timer was already queued when it was cleared.
    class LeakyClock extends FakeClock {
      clearTimeout = () => {};
    }
    const clock = new LeakyClock();
    const p = new PlaybackController(clock);
    p.load(TEXT, timelineFor(TEXT));
    const heard = vi.fn();
    p.onKeystroke(heard);
    p.start();
    clock.advance(300);
    expect(p.buffer.text()).toBe("a");
    p.pause();
    clock.advance(10_000); // the old timer fires while paused
    expect(p.buffer.text()).toBe("a");
    p.resume(); // old generation timers may still be pending alongside the new one
    p.pause();
    p.resume();
    clock.advance(2000);
    expect(p.getStatus()).toBe("completed");
    expect(p.buffer.text()).toBe(TEXT);
    expect(heard).toHaveBeenCalledTimes(TEXT.length);
  });

  it("keeps the newest notes first and shows at most eight", () => {
    const source = "x".repeat(40);
    const tl = timelineFromSteps(
      source,
      Array.from({ length: 40 }, (_, i) => ({ text: "x", note: `note ${i}` })),
    );
    const clock = new FakeClock();
    const p = new PlaybackController(clock);
    p.load(source, tl);
    p.start();
    clock.advance(10_000);
    expect(p.getStatus()).toBe("completed");
    const recent = p.getSnapshot().recent;
    expect(recent).toHaveLength(8);
    expect(recent.map((r) => r.note)).toEqual(Array.from({ length: 8 }, (_, i) => `note ${39 - i}`));
    expect(recent[0].at).toBe(40 * 200);
  });
});

describe("PlaybackController output verification", () => {
  const playMismatch = (source: string, timelineText: string) => {
    const clock = new FakeClock();
    const p = new PlaybackController(clock);
    p.load(source, timelineFor(timelineText));
    p.start();
    clock.advance(5000);
    return p;
  };

  it("reports the first missing character when the output stops early", () => {
    const p = playMismatch("abcd", "abc");
    expect(p.getStatus()).toBe("error");
    expect(p.getSnapshot().error).toBe("Playback output differs from your text at character 4. Your original text is unchanged.");
    expect(p.getSource()).toBe("abcd");
  });

  it("reports the first extra character when the output runs long", () => {
    const p = playMismatch("ab", "abc");
    expect(p.getStatus()).toBe("error");
    expect(p.getSnapshot().error).toMatch(/at character 3\./);
  });

  it("treats leftover typo cells as a failure even when the text matches", () => {
    const clock = new FakeClock();
    const p = new PlaybackController(clock);
    p.load("a", timelineFromSteps("a", [{ text: "a", err: true }]));
    p.start();
    clock.advance(1000);
    expect(p.buffer.text()).toBe("a");
    expect(p.getStatus()).toBe("error");
    expect(p.getSnapshot().error).toMatch(/Your original text is unchanged/);
    // It points at the typo cell, not one past the end of the text.
    expect(p.getSnapshot().error).toMatch(/at character 1\./);
    // An errored session can be reset and loaded again.
    expect(p.reset()).toBe(true);
    expect(p.getStatus()).toBe("ready");
  });
});
