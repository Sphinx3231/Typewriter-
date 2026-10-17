import { afterEach, describe, expect, it, vi } from "vitest";
import { buildScript, buildTimeline, DEFAULT_SETTINGS, type Timeline } from "../engine";
import type { Bridge, NativeUpdate } from "./bridge";
import { ExternalController, START_LIMIT_MS } from "./external";

interface FakeOpts {
  /** start() rejects with this value. */
  failStart?: unknown;
  /** control() rejects. */
  controlFails?: boolean;
  /** readClipboard() rejects. */
  clipboardFails?: boolean;
  clipboard?: string;
}

function fakeBridge(opts: FakeOpts = {}) {
  const calls: string[] = [];
  let push: (u: NativeUpdate) => void = () => {};
  const tokens: (number | undefined)[] = [];
  let release: () => void = () => {};
  let gate: Promise<void> | null = null;
  const bridge: Bridge = {
    support: async () => ({ available: true, state: "ok", platform: "linux", message: "ok" }),
    start: async (_events, _countdown, _minimize, _source, token) => {
      calls.push("start");
      tokens.push(token);
      if (gate) await gate;
      if (opts.failStart !== undefined) throw opts.failStart;
      return { shortcutRegistered: false };
    },
    control: async (c) => {
      calls.push(c);
      if (opts.controlFails) throw new Error("no native session");
    },
    readClipboard: async () => {
      if (opts.clipboardFails) throw new Error("clipboard blocked");
      return opts.clipboard ?? "";
    },
    showMain: async () => {},
    onUpdate: (fn) => {
      push = fn;
      return () => {};
    },
  };
  return {
    bridge,
    calls,
    tokens,
    /** Holds every later start() until the returned function is called. */
    hold: () => {
      gate = new Promise<void>((r) => (release = r));
      return () => release();
    },
    push: (u: Partial<NativeUpdate>) => push({ phase: "typing", index: 0, elapsedMs: 0, totalMs: 0, countdownMs: 0, target: null, reason: null, message: null, ...u }),
  };
}

const TEXT = "Hello there, world.";
const timeline = (text = TEXT, mistakes: "off" | "medium" = "off", durationSec = 10) => {
  const s = { ...DEFAULT_SETTINGS, mistakes, seed: 3 };
  return buildTimeline(buildScript(text, s), { ...s, timingMode: "duration", durationSec });
};
const emptyTimeline = (): Timeline => ({ ...timeline(), events: [], times: new Float64Array() });

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe("external output adapter: lifecycle details", () => {
  it("exposes the loaded source and timeline; an empty timeline can't be started", () => {
    const c = new ExternalController(fakeBridge().bridge);
    expect(c.getStatus()).toBe("empty");
    expect(c.getTimeline()).toBeNull();
    expect(c.getSource()).toBe("");
    expect(c.start()).toBe(false); // nothing loaded

    const tl = timeline();
    expect(c.load(TEXT, tl)).toBe(true);
    expect(c.getSource()).toBe(TEXT);
    expect(c.getTimeline()).toBe(tl);

    expect(c.load("", emptyTimeline())).toBe(true);
    expect(c.getStatus()).toBe("empty");
    expect(c.start()).toBe(false);
    expect(c.load("", null)).toBe(true);
    expect(c.getStatus()).toBe("empty");
  });

  it("refuses to load, start again or reset while a session runs", async () => {
    const f = fakeBridge();
    const c = new ExternalController(f.bridge);
    c.load(TEXT, timeline());
    expect(c.start()).toBe(true);
    expect(c.start()).toBe(false);
    expect(c.load("other", timeline("other"))).toBe(false);
    expect(c.getSource()).toBe(TEXT);
    expect(c.reset()).toBe(false);
    expect(c.getStatus()).toBe("playing");
    expect(f.calls.filter((x) => x === "start")).toHaveLength(1);
  });

  it("notifies subscribers on every change until they unsubscribe", async () => {
    const f = fakeBridge();
    const c = new ExternalController(f.bridge);
    const seen: string[] = [];
    const off = c.subscribe(() => seen.push(c.getSnapshot().status));
    c.load(TEXT, timeline());
    c.start();
    c.refresh();
    expect(seen).toEqual(["ready", "playing", "playing"]);
    off();
    c.stop();
    expect(seen).toHaveLength(3);
    expect(c.getStatus()).toBe("stopped");
  });

  it("uses the configured countdown and minimise setting, and records whether the stop shortcut is registered", async () => {
    const f = fakeBridge();
    const start = vi.spyOn(f.bridge, "start");
    const c = new ExternalController(f.bridge);
    c.configure({ countdownMs: 12_000 });
    c.configure({ minimize: false });
    c.load(TEXT, timeline());
    c.start();
    expect(start).toHaveBeenCalledWith(expect.any(Array), 12_000, false, TEXT, expect.any(Number));
    expect(c.getSnapshot().external?.countdownMs).toBe(12_000);
    expect(c.getSnapshot().external?.shortcutRegistered).toBe(true);
    await flush();
    expect(c.getSnapshot().external?.shortcutRegistered).toBe(false);
  });

  it("reports keystrokes the engine just sent to keystroke listeners, but not old ones from a catch-up batch", () => {
    const f = fakeBridge();
    const c = new ExternalController(f.bridge);
    const tl = timeline();
    c.load(TEXT, tl);
    c.start();
    const heard: number[] = [];
    const off = c.onKeystroke((ev) => heard.push(ev.at));
    const n = tl.events.length;
    // A batch of 5 keys arriving well after the first ones were due: only recent keys sound.
    const last = tl.events[4];
    f.push({ phase: "typing", index: 5, elapsedMs: last.at + 100 });
    expect(heard).toEqual(tl.events.slice(0, 5).filter((e) => last.at + 100 - e.at < 150).map((e) => e.at));
    expect(heard.length).toBeGreaterThan(0);
    expect(heard.length).toBeLessThan(5);
    off();
    f.push({ phase: "typing", index: n, elapsedMs: tl.events[n - 1].at });
    expect(heard.length).toBeLessThan(5);
  });

  it("estimates the elapsed time between native updates while typing, and the live WPM", () => {
    let now = 1000;
    const f = fakeBridge();
    const c = new ExternalController(f.bridge, () => now);
    const tl = timeline(TEXT, "off", 10);
    c.load(TEXT, tl);
    c.start();
    f.push({ phase: "typing", index: 10, elapsedMs: 4000 });
    expect(c.getElapsed()).toBe(4000);
    now += 500;
    expect(c.getElapsed()).toBe(4500);
    now += 1_000_000;
    expect(c.getElapsed()).toBe(tl.totalMs); // never past the end
    const snap = c.getSnapshot();
    expect(snap.sourceDone).toBe(tl.events[9].src);
    expect(snap.currentWpm).toBeCloseTo((tl.events[9].src / 5) * (60_000 / 4000));
    // While paused the clock stands still.
    f.push({ phase: "paused", index: 10, elapsedMs: 4000 });
    now += 5000;
    expect(c.getElapsed()).toBe(4000);
  });

  it("keeps the most recent correction notes for the activity log, newest first", () => {
    const text = "The quick brown fox jumps over the lazy dog while teh cat recieves mail. ".repeat(30).trim();
    const tl = timeline(text, "medium", 600);
    const notes = tl.events.filter((e) => e.note);
    expect(notes.length).toBeGreaterThan(30);
    const f = fakeBridge();
    const c = new ExternalController(f.bridge);
    c.load(text, tl);
    c.start();
    f.push({ phase: "typing", index: tl.events.length, elapsedMs: tl.totalMs });
    const recent = c.getSnapshot().recent;
    expect(recent).toHaveLength(8);
    expect(recent.map((r) => r.note)).toEqual(notes.slice(-8).reverse().map((e) => e.note));
    f.push({ phase: "completed", index: tl.events.length, elapsedMs: tl.totalMs });
    expect(c.getStatus()).toBe("completed");
    expect(c.buffer.text()).toBe(text);
  });

  it("reset after a session clears the mirror and makes it ready again", () => {
    const f = fakeBridge();
    const c = new ExternalController(f.bridge);
    const tl = timeline();
    c.load(TEXT, tl);
    c.start();
    f.push({ phase: "completed", index: tl.events.length, elapsedMs: tl.totalMs });
    expect(c.buffer.text()).toBe(TEXT);
    expect(c.reset()).toBe(true);
    expect(c.getStatus()).toBe("ready");
    expect(c.buffer.text()).toBe("");
    expect(c.getSnapshot().external?.phase).toBe("idle");
    expect(c.getSnapshot().eventIndex).toBe(0);

    c.load("", emptyTimeline());
    expect(c.reset()).toBe(true);
    expect(c.getStatus()).toBe("empty");
  });
});

describe("external output adapter: controls", () => {
  it("pause is sent while typing, resume only while paused", () => {
    const f = fakeBridge();
    const c = new ExternalController(f.bridge);
    c.load(TEXT, timeline());
    c.start();
    expect(c.resume()).toBe(false);
    f.push({ phase: "typing", index: 2, elapsedMs: 200 });
    expect(c.resume()).toBe(false);
    expect(c.pause()).toBe(true);
    expect(f.calls).toEqual(["start", "pause"]);
    f.push({ phase: "resuming", index: 2, elapsedMs: 200, countdownMs: 2000 });
    expect(c.getStatus()).toBe("paused");
    expect(c.resume()).toBe(false); // already resuming
    f.push({ phase: "paused", index: 2, elapsedMs: 200 });
    expect(c.resume()).toBe(true);
    expect(f.calls).toEqual(["start", "pause", "resume"]);
  });

  it("pause/resume failures are swallowed (the engine reports the real state)", async () => {
    const f = fakeBridge({ controlFails: true });
    const c = new ExternalController(f.bridge);
    c.load(TEXT, timeline());
    c.start();
    f.push({ phase: "typing", index: 1, elapsedMs: 100 });
    expect(c.pause()).toBe(true);
    f.push({ phase: "paused", index: 1, elapsedMs: 100 });
    expect(c.resume()).toBe(true);
    await flush();
    expect(c.getStatus()).toBe("paused");
  });

  it("stop is refused when nothing runs", () => {
    const f = fakeBridge();
    const c = new ExternalController(f.bridge);
    expect(c.stop()).toBe(false);
    c.load(TEXT, timeline());
    expect(c.stop()).toBe(false);
    expect(f.calls).toEqual([]);
  });

  it("stop mid-typing asks the engine and waits for it to report the stop", async () => {
    const f = fakeBridge();
    const c = new ExternalController(f.bridge);
    c.load(TEXT, timeline());
    c.start();
    await flush();
    f.push({ phase: "typing", index: 4, elapsedMs: 400 });
    expect(c.stop()).toBe(true);
    await flush();
    expect(f.calls).toContain("stop");
    expect(c.getStatus()).toBe("playing"); // not settled locally while the engine is alive
    f.push({ phase: "stopped", index: 4, elapsedMs: 400, reason: "user", message: "Stopped." });
    expect(c.getStatus()).toBe("stopped");
    expect(c.getSnapshot().external?.message).toBe("Stopped.");
    expect(c.buffer.text()).toBe(TEXT.slice(0, c.getSnapshot().sourceDone));
  });

  it("stop mid-typing settles locally when there is no native session any more", async () => {
    const f = fakeBridge({ controlFails: true });
    const c = new ExternalController(f.bridge);
    c.load(TEXT, timeline());
    c.start();
    await flush();
    f.push({ phase: "paused", index: 4, elapsedMs: 400 });
    expect(c.stop()).toBe(true);
    await flush();
    expect(c.getStatus()).toBe("stopped");
    expect(c.getSnapshot().external?.phase).toBe("stopped");
  });

  it("stop while preparing settles at once even if the engine can't be reached", async () => {
    const f = fakeBridge({ controlFails: true });
    const c = new ExternalController(f.bridge);
    c.load(TEXT, timeline());
    c.start();
    await flush();
    expect(c.stop()).toBe(true);
    expect(c.getStatus()).toBe("stopped");
    expect(c.getSnapshot().external?.message).toMatch(/Nothing was typed/);
    await flush();
    expect(c.getStatus()).toBe("stopped");
  });

  it("a stop that couldn't reach the engine while Start was pending is retried once Start returns", async () => {
    const f = fakeBridge({ controlFails: true });
    const release = f.hold();
    const c = new ExternalController(f.bridge);
    c.load(TEXT, timeline());
    c.start();
    c.stop();
    release();
    await flush();
    await flush();
    expect(f.calls.filter((x) => x === "stop")).toHaveLength(2);
    expect(c.getStatus()).toBe("stopped");
  });
});

describe("external output adapter: start failures and stale answers", () => {
  it("an unexplained start failure shows a generic message", async () => {
    const f = fakeBridge({ failStart: "engine crashed" });
    const c = new ExternalController(f.bridge);
    c.load(TEXT, timeline());
    c.start();
    await flush();
    expect(c.getStatus()).toBe("error");
    expect(c.getSnapshot().error).toBe("Couldn't start typing: engine crashed");
    expect(c.getSnapshot().external?.phase).toBe("failed");
    expect(c.getSnapshot().external?.reason).toBe("start-failed");
    // A new attempt is possible after an error.
    expect(c.start()).toBe(true);
  });

  it("a start failure after the user already stopped doesn't turn the stop into an error", async () => {
    const f = fakeBridge({ failStart: "engine crashed" });
    const release = f.hold();
    const c = new ExternalController(f.bridge);
    c.load(TEXT, timeline());
    c.start();
    c.stop();
    release();
    await flush();
    expect(c.getStatus()).toBe("stopped");
    expect(c.getSnapshot().error).toBeNull();
  });

  it("the answer to an earlier Start can't change a newer session", async () => {
    const f = fakeBridge();
    const release = f.hold();
    const c = new ExternalController(f.bridge);
    c.load(TEXT, timeline());
    c.start();
    c.stop();
    c.start(); // second session while the first Start is still pending
    release();
    await flush();
    // Only the second session's answer counts; the first one isn't stopped twice.
    expect(f.calls.filter((x) => x === "stop")).toHaveLength(1);
    expect(c.getStatus()).toBe("playing");
    expect(c.getSnapshot().external?.shortcutRegistered).toBe(false);
  });

  it("a failure answer to an earlier Start can't fail a newer session", async () => {
    const f = fakeBridge({ failStart: "old engine gone" });
    const release = f.hold();
    const c = new ExternalController(f.bridge);
    c.load(TEXT, timeline());
    c.start();
    c.stop();
    c.start();
    expect(c.getStatus()).toBe("playing");
    release();
    await flush();
    // The newer session fails on its own answer, with its own message, exactly once.
    expect(c.getStatus()).toBe("error");
    expect(c.getSnapshot().error).toBe("Couldn't start typing: old engine gone");
  });

  it("the start limit still settles when the engine can't even be told to stop", async () => {
    vi.useFakeTimers();
    const f = fakeBridge({ controlFails: true });
    f.hold(); // Start never returns
    const c = new ExternalController(f.bridge);
    c.load(TEXT, timeline());
    c.start();
    await vi.advanceTimersByTimeAsync(START_LIMIT_MS + 10);
    expect(c.getStatus()).toBe("error");
    expect(c.getSnapshot().external?.reason).toBe("start-timeout");
  });
});

describe("external output adapter: how a session ends", () => {
  it("completion whose keys don't add up to the text is an error, not a success", () => {
    const f = fakeBridge();
    const c = new ExternalController(f.bridge);
    const tl = timeline();
    c.load(TEXT, tl);
    c.start();
    f.push({ phase: "completed", index: 3, elapsedMs: tl.totalMs });
    expect(c.getStatus()).toBe("error");
    expect(c.getSnapshot().error).toBe("The keys sent don't add up to your text. Check the document.");
    expect(c.getSnapshot().external?.verification).toBe("not-run");
  });

  it("uses the destination's own read-back when the engine provides one", () => {
    for (const [status, expected] of [
      ["verified", "verified"],
      ["mismatch", "mismatch"],
      ["unreadable", "sent"],
    ] as const) {
      const f = fakeBridge();
      const c = new ExternalController(f.bridge);
      const tl = timeline();
      c.load(TEXT, tl);
      c.start();
      f.push({ phase: "completed", index: tl.events.length, elapsedMs: tl.totalMs, verification: { status, detail: `detail ${status}` } });
      expect(c.getStatus()).toBe("completed");
      expect(c.getSnapshot().external?.verification).toBe(expected);
      expect(c.getSnapshot().external?.verificationDetail).toBe(`detail ${status}`);
      expect(c.getSnapshot().elapsedMs).toBe(tl.totalMs);
    }
  });

  it("a failure without an explanation still says what happened", () => {
    const f = fakeBridge();
    const c = new ExternalController(f.bridge);
    c.load(TEXT, timeline());
    c.start();
    f.push({ phase: "failed" });
    expect(c.getStatus()).toBe("error");
    expect(c.getSnapshot().error).toBe("Typing into the other app failed.");
  });

  it("keeps the last known target window when an update doesn't name one", () => {
    const f = fakeBridge();
    const c = new ExternalController(f.bridge);
    c.load(TEXT, timeline());
    c.start();
    f.push({ phase: "typing", index: 1, elapsedMs: 50, target: { windowId: "7", processId: 1, appName: "Kate", title: "draft.txt" } });
    f.push({ phase: "typing", index: 2, elapsedMs: 100 });
    expect(c.getSnapshot().external?.target).toEqual({ title: "draft.txt", appName: "Kate" });
  });
});

describe("external output adapter: copy-back verification", () => {
  it("records a mismatch the user found", async () => {
    const f = fakeBridge({ clipboard: "Hello there, wrold." });
    const c = new ExternalController(f.bridge);
    const tl = timeline();
    c.load(TEXT, tl);
    c.start();
    f.push({ phase: "completed", index: tl.events.length, elapsedMs: tl.totalMs });
    const r = await c.verifyFromClipboard();
    expect(r.status).toBe("mismatch");
    expect(c.getSnapshot().external?.verification).toBe("mismatch");
    expect(c.getSnapshot().external?.verificationDetail).toBe(r.detail);
  });

  it("an empty or unreadable clipboard leaves the result as sent", async () => {
    for (const opts of [{ clipboard: "" }, { clipboardFails: true }]) {
      const f = fakeBridge(opts);
      const c = new ExternalController(f.bridge);
      const tl = timeline();
      c.load(TEXT, tl);
      c.start();
      f.push({ phase: "completed", index: tl.events.length, elapsedMs: tl.totalMs });
      const r = await c.verifyFromClipboard();
      expect(r.status).toBe("empty");
      expect(c.getSnapshot().external?.verification).toBe("sent");
    }
  });
});
