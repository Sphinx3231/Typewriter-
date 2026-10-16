import { describe, expect, it } from "vitest";
import { buildScript, buildTimeline, DEFAULT_SETTINGS, type TypingEvent } from "../engine";
import type { Bridge, NativeUpdate } from "./bridge";
import { ExternalController } from "./external";
import { verifyCopiedText } from "./verify";

function fakeBridge(opts: { failStart?: string; clipboard?: string } = {}) {
  const calls: string[] = [];
  let push: (u: NativeUpdate) => void = () => {};
  let started: TypingEvent[] = [];
  const bridge: Bridge = {
    support: async () => ({ available: true, state: "ok", platform: "linux", message: "ok" }),
    start: async (events) => {
      calls.push("start");
      started = events;
      if (opts.failStart) throw opts.failStart;
      return { shortcutRegistered: true };
    },
    control: async (c) => {
      calls.push(c);
    },
    readClipboard: async () => opts.clipboard ?? "",
    showMain: async () => {},
    onUpdate: (fn) => {
      push = fn;
      return () => {};
    },
  };
  return { bridge, calls, push: (u: Partial<NativeUpdate>) => push({ phase: "typing", index: 0, elapsedMs: 0, totalMs: 0, countdownMs: 0, target: null, reason: null, message: null, ...u }), events: () => started };
}

const TEXT = "I recieve teh mail.\nSecond line 👍🏽 with a\ttab.";
const settings = { ...DEFAULT_SETTINGS, mistakes: "medium" as const, seed: 5 };
const timeline = () => buildTimeline(buildScript(TEXT, settings), { ...settings, timingMode: "duration", durationSec: 10 });

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("external output adapter", () => {
  it("arms without typing, mirrors native progress, and never claims the document matches", async () => {
    const f = fakeBridge();
    const c = new ExternalController(f.bridge);
    const tl = timeline();
    c.load(TEXT, tl);
    expect(c.getStatus()).toBe("ready");
    expect(c.start()).toBe(true);
    await flush();
    expect(f.calls).toEqual(["start"]);
    expect(f.events()).toHaveLength(tl.events.length);
    expect(c.getSnapshot().external?.phase).toBe("waiting");
    expect(c.buffer.text()).toBe("");

    f.push({ phase: "countdown", countdownMs: 3000 });
    expect(c.getSnapshot().external?.phase).toBe("countdown");
    expect(c.getStatus()).toBe("playing");

    const half = Math.floor(tl.events.length / 2);
    f.push({ phase: "typing", index: half, elapsedMs: tl.events[half - 1].at, target: { windowId: "1", processId: 9, appName: "Chrome", title: "Doc" } });
    expect(c.getSnapshot().eventIndex).toBe(half);
    expect(c.getSnapshot().external?.target?.appName).toBe("Chrome");

    f.push({ phase: "paused", index: half, elapsedMs: tl.events[half - 1].at, reason: "focus-changed", message: "Focus moved" });
    expect(c.getStatus()).toBe("paused");
    expect(c.resume()).toBe(true);
    expect(f.calls).toContain("resume");

    f.push({ phase: "completed", index: tl.events.length, elapsedMs: tl.totalMs });
    expect(c.getStatus()).toBe("completed");
    expect(c.buffer.text()).toBe(TEXT);
    // Sent, not verified.
    expect(c.getSnapshot().external?.verification).toBe("sent");
  });

  it("restart is not offered (it would duplicate text already in the document)", () => {
    const c = new ExternalController(fakeBridge().bridge);
    c.load(TEXT, timeline());
    c.start();
    expect(c.canRestart).toBe(false);
    expect(c.restart()).toBe(false);
  });

  it("pause is only sent while actually typing; stop works while arming", async () => {
    const f = fakeBridge();
    const c = new ExternalController(f.bridge);
    c.load(TEXT, timeline());
    c.start();
    await flush();
    expect(c.pause()).toBe(false); // still waiting for the user to switch
    expect(c.stop()).toBe(true);
    expect(f.calls).toContain("stop");
    f.push({ phase: "stopped", reason: "user" });
    expect(c.getStatus()).toBe("stopped");
  });

  it("permission denied surfaces as an error with the native explanation", async () => {
    const msg = JSON.stringify({ available: false, state: "permission-denied", platform: "macos", message: "Needs Accessibility permission." });
    const f = fakeBridge({ failStart: msg });
    const c = new ExternalController(f.bridge);
    c.load(TEXT, timeline());
    c.start();
    await flush();
    await flush();
    expect(c.getStatus()).toBe("error");
    expect(c.getSnapshot().error).toBe("Needs Accessibility permission.");
    expect(c.getSnapshot().external?.reason).toBe("permission-denied");
  });

  it("verification compares the copied document text exactly", async () => {
    const f = fakeBridge({ clipboard: TEXT.replace(/\n/g, "\r\n") });
    const c = new ExternalController(f.bridge);
    const tl = timeline();
    c.load(TEXT, tl);
    c.start();
    f.push({ phase: "completed", index: tl.events.length, elapsedMs: tl.totalMs });
    const r = await c.verifyFromClipboard();
    expect(r.status).toBe("verified");
    expect(c.getSnapshot().external?.verification).toBe("verified");
  });

  it("ignores stale updates when nothing is running", () => {
    const f = fakeBridge();
    const c = new ExternalController(f.bridge);
    c.load(TEXT, timeline());
    f.push({ phase: "typing", index: 5 });
    expect(c.getSnapshot().eventIndex).toBe(0);
    expect(c.getStatus()).toBe("ready");
  });
});

describe("copy-back verification", () => {
  it("only accepts exact matches (line endings normalised)", () => {
    expect(verifyCopiedText("a\nb", "a\r\nb").status).toBe("verified");
    expect(verifyCopiedText("a\nb", "a\nb\n").status).toBe("verified");
    expect(verifyCopiedText("teh cat", "the cat").status).toBe("mismatch");
    expect(verifyCopiedText("\"quoted\"", "“quoted”").status).toBe("mismatch");
    expect(verifyCopiedText("abc", "ab").detail).toMatch(/stops early/);
    expect(verifyCopiedText("abc", "abcd").detail).toMatch(/extra content/);
    expect(verifyCopiedText("abc", "").status).toBe("empty");
    expect(verifyCopiedText("tab\there", "tab here").status).toBe("mismatch");
  });
});
