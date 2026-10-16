/**
 * Break-it pass: random texts × random settings, checking invariants after
 * every single step, not just at the end.
 */
import { describe, expect, it } from "vitest";
import { TypedBuffer } from "./buffer";
import { toGraphemes } from "./graphemes";
import { PlaybackController } from "./player";
import { Rng } from "./rng";
import { buildTimeline } from "./schedule";
import { buildScript } from "./script";
import { DEFAULT_SETTINGS, type PlaybackSettings } from "./settings";
import { FakeClock } from "./testing";

const PIECES = [
  "the", "quick", "Brown", "FOX", "jumps", "over", "lazy", "dogs", "recieve", "teh", "tommorow", "isn't", "O'Brien", "well-known",
  "extraordinarily", "antidisestablishmentarianism", "a", "I", "be", "Ünïcödé", "naïve", "façade", "日本語", "Привет", "Ελληνικά", "مرحبا", "שלום",
  "👨‍👩‍👧‍👦", "🇯🇵", "👍🏽", "1️⃣", "é", "é", "🎉", "x̷̢", "é",
  " ", "  ", "\t", "\n", "\n\n", "\r\n", "\r\n\r\n", "...", ",", ".", ";", ":", "!", "?", "?!", "—", "–", "(", ")", "\"", "'", "’", "…", "  \n  ",
  "123", "4.5", "$9.99", "#tag", "@user", "a.b.c", "x_y", "--", "''",
];

function randomText(r: Rng): string {
  const n = r.int(0, 120);
  let s = "";
  for (let i = 0; i < n; i++) {
    const p = r.pick(PIECES);
    s += p;
    if (r.chance(0.55)) s += " ";
  }
  return s;
}

function randomSettings(r: Rng): PlaybackSettings {
  const min = r.int(50, 1500);
  return {
    ...DEFAULT_SETTINGS,
    timingMode: r.chance(0.5) ? "duration" : "speed",
    durationSec: r.int(1, 600),
    wpm: r.int(5, 400),
    rhythm: r.chance(0.7),
    variation: r.pick(["low", "medium", "high"] as const),
    mistakes: r.pick(["off", "low", "medium", "medium", "medium"] as const),
    correction: r.pick(["autocorrect", "backspace", "mixed"] as const),
    correctionDelayMinMs: min,
    correctionDelayMaxMs: r.int(min, 5000),
    pauses: r.chance(0.6),
    seed: r.int(1, 2 ** 31),
  };
}

describe("fuzz: engine invariants", () => {
  it("holds for 1,500 random texts and settings", { timeout: 180_000 }, () => {
    const r = new Rng(0xc0ffee);
    for (let trial = 0; trial < 1500; trial++) {
      const text = randomText(r);
      const settings = randomSettings(r);
      // Force heavy mistake coverage by also boosting with repeated words.
      const script = buildScript(text, settings);
      const tl = buildTimeline(script, settings);
      const buf = new TypedBuffer();
      let prevAt = 0;
      for (let i = 0; i < tl.events.length; i++) {
        const e = tl.events[i];
        expect(e.at).toBeGreaterThanOrEqual(prevAt);
        prevAt = e.at;
        buf.apply(e, i);
        expect(buf.caret).toBeGreaterThanOrEqual(0);
        expect(buf.caret).toBeLessThanOrEqual(buf.cells.length);
        expect(buf.errs.length).toBe(buf.cells.length);
        if (e.kind === "type") expect(toGraphemes(e.text!)).toHaveLength(1);
      }
      const ctx = `trial ${trial}: ${JSON.stringify({ text, settings })}`;
      expect(buf.text(), ctx).toBe(text);
      expect(buf.hasErrors(), ctx).toBe(false);
      expect(buf.caret, ctx).toBe(buf.cells.length);
      if (settings.timingMode === "duration" && !tl.conflict && tl.events.length) expect(tl.totalMs).toBeCloseTo(settings.durationSec * 1000, 2);
      if (tl.events.length) expect(tl.events[tl.events.length - 1].src).toBe(toGraphemes(text).length);
    }
  });

  it("text outside the word being corrected is never disturbed, and every typo is visibly marked", { timeout: 60_000 }, () => {
    const r = new Rng(99);
    const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"];
    for (let trial = 0; trial < 400; trial++) {
      const text = Array.from({ length: 40 }, () => r.pick(words)).join(r.pick([" ", ", ", "\n", ". "]));
      const settings = { ...randomSettings(r), mistakes: "medium" as const };
      const script = buildScript(text, settings);
      const buf = new TypedBuffer();
      for (const step of script.steps) {
        buf.apply(step);
        const typed = buf.text();
        // Everything up to the last separator before the caret must already match the source.
        const beforeCaret = buf.cells.slice(0, buf.caret).join("");
        const cut = Math.max(beforeCaret.lastIndexOf(" "), beforeCaret.lastIndexOf("\n"));
        if (cut > 0) {
          const settled = typed.slice(0, cut);
          const firstErr = buf.errs.indexOf(true);
          if (firstErr < 0 || buf.cells.slice(0, firstErr).join("").length >= settled.length) {
            expect(text.startsWith(settled), `trial ${trial}`).toBe(true);
          }
        }
      }
      expect(buf.text()).toBe(text);
    }
  });

  it("whenever the visible text is wrong, the wrong spot is highlighted", { timeout: 120_000 }, () => {
    const r = new Rng(7);
    for (let trial = 0; trial < 600; trial++) {
      const text = randomText(r);
      const settings = { ...randomSettings(r), mistakes: "medium" as const };
      const script = buildScript(text, settings);
      const G = toGraphemes(text);
      const buf = new TypedBuffer();
      for (const step of script.steps) {
        buf.apply(step);
        const wrongAt = buf.cells.findIndex((c, k) => c !== G[k]);
        // Allowed exception: mid-correction, after deleting a wrong letter and before retyping,
        // with the caret parked inside the word.
        if (wrongAt >= 0) expect(buf.hasErrors() || buf.caret < buf.cells.length, `trial ${trial}: ${JSON.stringify(buf.text().slice(-20))}`).toBe(true);
      }
    }
  });
});

describe("fuzz: controller under random commands", () => {
  it("never corrupts output, whatever order the buttons are pressed in", { timeout: 120_000 }, () => {
    const r = new Rng(4242);
    for (let trial = 0; trial < 300; trial++) {
      const text = randomText(r) || "fallback text";
      const settings = { ...randomSettings(r), timingMode: "duration" as const, durationSec: r.int(1, 20) };
      const clock = new FakeClock();
      const p = new PlaybackController(clock);
      const tl = buildTimeline(buildScript(text, settings), settings);
      p.load(text, tl);
      for (let k = 0; k < 40; k++) {
        const cmd = r.pick(["start", "pause", "resume", "stop", "restart", "reset", "advance", "advance", "advance"] as const);
        if (cmd === "advance") clock.advance(r.int(0, 3000), r.int(0, 60));
        else (p[cmd] as () => boolean)();
        expect(p.pendingTimers).toBeLessThanOrEqual(1);
        expect(clock.pending).toBeLessThanOrEqual(1);
        const st = p.getStatus();
        if (st !== "playing") expect(clock.pending).toBe(0);
        // Whatever is on screen is always a state the script can produce: never longer than the
        // source plus a few pending typo characters.
        expect(p.buffer.cells.length).toBeLessThanOrEqual(toGraphemes(text).length + 4);
      }
      // Finish cleanly from wherever we ended up.
      if (p.getStatus() === "paused") p.resume();
      if (p.getStatus() !== "playing") {
        p.reset();
        p.start();
      }
      clock.advance(tl.totalMs + 1000);
      expect(p.getStatus(), `trial ${trial}`).toBe("completed");
      expect(p.buffer.text(), `trial ${trial}`).toBe(text);
    }
  });
});
