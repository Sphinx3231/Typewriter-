import { describe, expect, it } from "vitest";
import { TypedBuffer } from "./buffer";
import { toGraphemes } from "./graphemes";
import { PlaybackController, TRANSITIONS } from "./player";
import { buildTimeline, durationForWpm, estimate, MIN_UNIT_MS, wpmForDuration } from "./schedule";
import { buildScript, type RealismOptions } from "./script";
import { DEFAULT_SETTINGS, validateSettings, type PlaybackSettings } from "./settings";
import { computeStats } from "./stats";
import { FakeClock } from "./testing";

const LONG = Array.from({ length: 400 }, (_, i) => `Sentence number ${i + 1} talks about typewriters, ribbons and carriage returns.`).join(" ");

const TEXTS: Record<string, string> = {
  simple: "The quick brown fox jumps over the lazy dog.",
  paragraphs: "First paragraph, with a comma.\n\nSecond paragraph! Does it work?\nYes; it does: mostly.\n\n\nThird after two blank lines.",
  originalErrors: "I recieve teh mail evry day, and their going to the store tommorow. Me and him is friends.",
  unicode: "Café naïve résumé — „Zitat“ 日本語のテキスト. Ελληνικά κείμενα. Привет, мир!",
  emoji: "Family: 👨‍👩‍👧‍👦, flags 🇯🇵🇫🇷, skin 👍🏽, keycap 1️⃣ and combining é. Done 🎉",
  whitespace: "   leading spaces\tand\ttabs\n\n  indented line   \n\ttrailing tab\t\n   ",
  caps: "HELLO World. The NASA API uses JSON. McDonald's isn't O'Brien's.",
  punctuation: "Wait... what?! Yes, really; truly: completely. (Parentheses) [brackets] {braces} \"quotes\" 'single'.",
  long: LONG,
  single: "a",
  crlf: "line one\r\nline two\r\n\r\nline four",
};

const MODES: Partial<RealismOptions>[] = [
  { rhythm: false, pauses: false, mistakes: "off" },
  { rhythm: true, pauses: true, mistakes: "low", correction: "mixed" },
  { rhythm: true, pauses: true, mistakes: "medium", correction: "autocorrect" },
  { rhythm: true, pauses: false, mistakes: "medium", correction: "backspace", variation: "high" },
  { rhythm: false, pauses: true, mistakes: "medium", correction: "mixed", variation: "low" },
];

const opts = (o: Partial<RealismOptions>, seed: number): RealismOptions => ({ ...DEFAULT_SETTINGS, ...o, seed });

function replay(source: string, o: RealismOptions) {
  const script = buildScript(source, o);
  const buf = new TypedBuffer();
  script.steps.forEach((s, i) => buf.apply(s, i));
  return { script, buf };
}

describe("text integrity", () => {
  for (const [name, text] of Object.entries(TEXTS)) {
    it(`final output equals the source exactly: ${name}`, () => {
      const seeds = name === "long" ? 15 : 300;
      for (let seed = 1; seed <= seeds; seed++) {
        for (const mode of MODES) {
          const { buf } = replay(text, opts(mode, seed * 7919));
          expect(buf.text()).toBe(text);
          expect(buf.hasErrors()).toBe(false);
          expect(buf.caret).toBe(buf.cells.length);
        }
      }
      // Thousands of replays: allow for a busy machine (coverage instrumentation, parallel files).
    }, 60_000);
  }

  it("keeps the user's own spelling and grammar mistakes", () => {
    const text = TEXTS.originalErrors;
    for (let seed = 1; seed <= 200; seed++) {
      const { buf } = replay(text, opts({ mistakes: "medium", correction: "autocorrect" }, seed));
      expect(buf.text()).toContain("recieve teh mail evry day");
      expect(buf.text()).toContain("their going to the store tommorow");
      expect(buf.text()).toBe(text);
    }
  });

  it("random texts with heavy mistakes always converge to the source", () => {
    const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ   ,.;:!?\n\t'-éü日😀";
    const chars = toGraphemes(alphabet);
    let x = 12345;
    const rand = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let t = 0; t < 400; t++) {
      const len = Math.floor(rand() * 200);
      let s = "";
      for (let i = 0; i < len; i++) s += chars[Math.floor(rand() * chars.length)];
      for (const mode of MODES) {
        const { buf } = replay(s, opts(mode, t + 1));
        expect(buf.text()).toBe(s);
      }
    }
  });

  it("never splits emoji or combining sequences", () => {
    const text = TEXTS.emoji;
    const { script } = replay(text, opts({ mistakes: "medium" }, 3));
    const typed = script.steps.filter((s) => s.kind === "type").map((s) => s.text!);
    for (const g of typed) expect(toGraphemes(g)).toHaveLength(1);
    expect(typed).toContain("👨‍👩‍👧‍👦");
    expect(typed).toContain("🇯🇵");
  });
});

describe("realism settings change the playback", () => {
  it("is deterministic for the same seed and different for a new seed", () => {
    const a = buildScript(TEXTS.long.slice(0, 3000), opts({ mistakes: "medium" }, 42));
    const b = buildScript(TEXTS.long.slice(0, 3000), opts({ mistakes: "medium" }, 42));
    const c = buildScript(TEXTS.long.slice(0, 3000), opts({ mistakes: "medium" }, 43));
    expect(JSON.stringify(a.steps)).toBe(JSON.stringify(b.steps));
    expect(JSON.stringify(a.steps)).not.toBe(JSON.stringify(c.steps));
  });

  it("clean mode types every character once at perfectly even intervals", () => {
    const text = TEXTS.paragraphs;
    const script = buildScript(text, opts({ rhythm: false, pauses: false, mistakes: "off" }, 1));
    expect(script.steps).toHaveLength(toGraphemes(text).length);
    expect(script.steps.every((s) => s.kind === "type" && s.u === 1 && s.p === 0 && s.ms === 0)).toBe(true);
    const tl = buildTimeline(script, { timingMode: "duration", durationSec: 10, wpm: 60 });
    const gaps = Array.from(tl.times).map((t, i, a) => t - (i ? a[i - 1] : 0));
    for (const g of gaps) expect(g).toBeCloseTo(gaps[0], 6);
  });

  it("rhythm on varies keystroke timing; variation level controls the spread", () => {
    const spread = (variation: PlaybackSettings["variation"]) => {
      const s = buildScript(TEXTS.long.slice(0, 4000), opts({ rhythm: true, pauses: false, mistakes: "off", variation }, 9));
      const us = s.steps.map((x) => x.u);
      const mean = us.reduce((a, b) => a + b, 0) / us.length;
      return Math.sqrt(us.reduce((a, b) => a + (b - mean) ** 2, 0) / us.length);
    };
    const low = spread("low");
    const med = spread("medium");
    const high = spread("high");
    expect(low).toBeGreaterThan(0.05);
    expect(med).toBeGreaterThan(low);
    expect(high).toBeGreaterThan(med);
  });

  it("natural pauses add time after punctuation and paragraphs only when enabled", () => {
    const on = buildScript(TEXTS.paragraphs, opts({ rhythm: false, pauses: true, mistakes: "off" }, 5));
    const off = buildScript(TEXTS.paragraphs, opts({ rhythm: false, pauses: false, mistakes: "off" }, 5));
    expect(off.pauseUnits).toBe(0);
    expect(on.pauseUnits).toBeGreaterThan(20);
    const g = toGraphemes(TEXTS.paragraphs);
    const afterPara = g.findIndex((_, i) => i > 1 && g[i - 1] === "\n" && g[i - 2] === "\n");
    const afterComma = g.indexOf(",") + 1;
    expect(on.steps[afterPara].p).toBeGreaterThanOrEqual(6);
    expect(on.steps[afterComma].p).toBeGreaterThanOrEqual(1);
  });

  it("mistakes off never produces a typo; low and medium produce some, medium more", () => {
    const text = TEXTS.long;
    const count = (m: PlaybackSettings["mistakes"]) => buildScript(text, opts({ mistakes: m }, 77)).mistakes;
    expect(count("off")).toBe(0);
    const off = buildScript(text, opts({ mistakes: "off" }, 77));
    expect(off.steps.some((s) => s.err || s.fix || s.kind !== "type")).toBe(false);
    expect(count("low")).toBeGreaterThan(5);
    expect(count("medium")).toBeGreaterThan(count("low"));
    // infrequent: well under one mistake per sentence
    expect(count("medium")).toBeLessThan(400 / 2);
  });

  it("autocorrect style replaces whole words and never uses backspace on words", () => {
    const s = buildScript(TEXTS.long, opts({ mistakes: "medium", correction: "autocorrect" }, 11));
    expect(s.steps.some((x) => x.kind === "replace")).toBe(true);
    expect(s.steps.some((x) => x.kind === "caret")).toBe(false);
    const autoNotes = s.steps.filter((x) => x.note?.startsWith("Autocorrected"));
    expect(autoNotes.length).toBeGreaterThan(3);
  });

  it("backspace style backspaces and retypes, sometimes after moving the caret back", () => {
    let caretMoves = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const s = buildScript(TEXTS.long, opts({ mistakes: "medium", correction: "backspace" }, seed));
      expect(s.steps.some((x) => x.kind === "replace")).toBe(false);
      expect(s.steps.some((x) => x.kind === "backspace")).toBe(true);
      caretMoves += s.steps.filter((x) => x.kind === "caret").length;
    }
    expect(caretMoves).toBeGreaterThan(0);
  });

  it("mid-sentence fixes after moving the caret keep the surrounding text intact", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const text = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike";
      const script = buildScript(text, opts({ mistakes: "medium", correction: "backspace" }, seed));
      const buf = new TypedBuffer();
      let sawMidFix = false;
      for (const step of script.steps) {
        buf.apply(step);
        if (step.kind === "type" && step.fix && buf.caret < buf.cells.length) sawMidFix = true;
        // the text before the active word is always a prefix of the source
        const typed = buf.text();
        const lastSpace = typed.lastIndexOf(" ");
        if (lastSpace > 0) expect(text.startsWith(typed.slice(0, lastSpace + 1))).toBe(true);
      }
      expect(buf.text()).toBe(text);
      if (sawMidFix) return;
    }
    throw new Error("no caret-move correction was generated in 300 seeds");
  });

  it("correction delays come from the configured range", () => {
    const s = buildScript(TEXTS.long, opts({ mistakes: "medium", correction: "backspace", correctionDelayMinMs: 900, correctionDelayMaxMs: 1000 }, 5));
    const waits = s.steps.filter((x) => x.kind === "wait" && x.ms > 0).map((x) => x.ms);
    expect(waits.length).toBeGreaterThan(0);
    for (const w of waits) {
      expect(w).toBeGreaterThanOrEqual(Math.round(900 * 0.6));
      expect(w).toBeLessThanOrEqual(1000);
    }
  });
});

describe("timing", () => {
  const script = buildScript(TEXTS.long.slice(0, 2000), opts({ mistakes: "low" }, 3));

  it("duration mode lands exactly on the requested duration", () => {
    for (const sec of [120, 601, 3600]) {
      const tl = buildTimeline(script, { timingMode: "duration", durationSec: sec, wpm: 60 });
      expect(tl.conflict).toBeNull();
      expect(tl.totalMs).toBeCloseTo(sec * 1000, 3);
    }
  });

  it("speed mode uses the keystroke speed and adds pauses and corrections on top", () => {
    const tl = buildTimeline(script, { timingMode: "speed", durationSec: 0, wpm: 60 });
    expect(tl.unitMs).toBeCloseTo(200);
    expect(tl.totalMs).toBeCloseTo(tl.typingMs + tl.pauseMs + tl.correctionMs, 3);
    expect(tl.pauseMs).toBeGreaterThan(0);
    expect(tl.effectiveWpm).toBeLessThan(60);
  });

  it("duration and speed convert into each other", () => {
    const sec = durationForWpm(script, 75);
    expect(wpmForDuration(script, sec)).toBeCloseTo(75, 6);
  });

  it("flags a duration that is too short for the realism settings and suggests minimums", () => {
    const est = estimate(script, { timingMode: "duration", durationSec: 1, wpm: 60 });
    expect(est.conflict).not.toBeNull();
    expect(est.conflict!.minimumMs).toBeGreaterThan(1000);
    expect(est.conflict!.minimumCleanMs).toBeLessThan(est.conflict!.minimumMs);
    expect(est.unitMs).toBe(MIN_UNIT_MS);
  });

  it("marks speeds beyond human typing and suggests a human-paced duration", () => {
    const fast = estimate(script, { timingMode: "duration", durationSec: 60, wpm: 60 });
    expect(fast.conflict).toBeNull();
    expect(fast.superhuman).toBe(true);
    const human = estimate(script, { timingMode: "duration", durationSec: fast.humanMinimumMs / 1000, wpm: 60 });
    expect(human.superhuman).toBe(false);
    expect(estimate(script, { timingMode: "speed", durationSec: 0, wpm: 90 }).superhuman).toBe(false);
  });

  it("event times are strictly ordered and never negative", () => {
    const tl = buildTimeline(script, { timingMode: "speed", durationSec: 0, wpm: 90 });
    for (let i = 1; i < tl.times.length; i++) expect(tl.times[i]).toBeGreaterThanOrEqual(tl.times[i - 1]);
    expect(tl.times[0]).toBeGreaterThanOrEqual(0);
  });
});

describe("statistics", () => {
  it("counts characters by grapheme, words, lines and paragraphs", () => {
    expect(computeStats("")).toMatchObject({ characters: 0, words: 0, lines: 0, paragraphs: 0 });
    expect(computeStats("Hi 👨‍👩‍👧‍👦!")).toMatchObject({ characters: 5, words: 2, lines: 1, paragraphs: 1 });
    expect(computeStats("a b\nc\n\n d e f\n")).toMatchObject({ words: 6, lines: 5, paragraphs: 2 });
    expect(computeStats("   \n\t ")).toMatchObject({ words: 0, paragraphs: 0, charactersNoSpaces: 0 });
  });
});

describe("settings validation", () => {
  it("accepts defaults and rejects out-of-range values with a message", () => {
    expect(validateSettings(DEFAULT_SETTINGS)).toEqual([]);
    expect(validateSettings({ ...DEFAULT_SETTINGS, timingMode: "duration", durationSec: 0 })[0].field).toBe("durationSec");
    expect(validateSettings({ ...DEFAULT_SETTINGS, wpm: 1000 })[0].field).toBe("wpm");
    expect(validateSettings({ ...DEFAULT_SETTINGS, correctionDelayMinMs: 900, correctionDelayMaxMs: 100 })).toHaveLength(1);
    expect(validateSettings({ ...DEFAULT_SETTINGS, wpm: Number.NaN })).toHaveLength(1);
  });
});

describe("playback controller", () => {
  const text = TEXTS.paragraphs;
  const make = (o: Partial<RealismOptions> = { mistakes: "medium" }, sec = 10) => {
    const clock = new FakeClock();
    const p = new PlaybackController(clock);
    const tl = buildTimeline(buildScript(text, opts(o, 7)), { timingMode: "duration", durationSec: sec, wpm: 60 });
    p.load(text, tl);
    return { clock, p, tl };
  };

  it("plays to completion and verifies the output", () => {
    const { clock, p } = make();
    expect(p.getStatus()).toBe("ready");
    expect(p.start()).toBe(true);
    clock.advance(5000);
    expect(p.getStatus()).toBe("playing");
    expect(p.buffer.text().length).toBeGreaterThan(0);
    expect(p.buffer.text().length).toBeLessThan(text.length);
    clock.advance(5001);
    expect(p.getStatus()).toBe("completed");
    expect(p.buffer.text()).toBe(text);
    const snap = p.getSnapshot();
    expect(snap.progress).toBe(1);
    expect(snap.elapsedMs).toBeCloseTo(10_000, 3);
    expect(clock.pending).toBe(0);
  });

  it("pause keeps the text, caret and position; resume continues from the same point", () => {
    const { clock, p } = make();
    p.start();
    clock.advance(4321);
    p.pause();
    const textAtPause = p.buffer.text();
    const caret = p.buffer.caret;
    const idx = p.getSnapshot().eventIndex;
    const elapsed = p.getSnapshot().elapsedMs;
    expect(clock.pending).toBe(0);
    clock.advance(60_000); // a long pause
    expect(p.buffer.text()).toBe(textAtPause);
    expect(p.buffer.caret).toBe(caret);
    expect(p.getSnapshot().eventIndex).toBe(idx);
    expect(p.getSnapshot().elapsedMs).toBe(elapsed);
    p.resume();
    clock.advance(10_000 - 4321 + 1);
    expect(p.getStatus()).toBe("completed");
    expect(p.buffer.text()).toBe(text);
  });

  it("many pause/resume cycles neither lose nor duplicate characters", () => {
    const { clock, p } = make({ mistakes: "medium", correction: "mixed" }, 20);
    p.start();
    for (let i = 0; i < 200; i++) {
      clock.advance(37);
      p.pause();
      clock.advance(500);
      p.resume();
      expect(p.pendingTimers).toBeLessThanOrEqual(1);
    }
    clock.advance(30_000);
    expect(p.getStatus()).toBe("completed");
    expect(p.buffer.text()).toBe(text);
  });

  it("restart clears output and plays the same sequence again without extra timers", () => {
    const { clock, p } = make();
    p.start();
    clock.advance(3000);
    const firstRun = p.buffer.text();
    p.restart();
    expect(p.buffer.text()).toBe("");
    expect(p.getSnapshot().elapsedMs).toBe(0);
    expect(clock.pending).toBeLessThanOrEqual(1);
    clock.advance(3000);
    expect(p.buffer.text()).toBe(firstRun);
    for (let i = 0; i < 20; i++) p.restart();
    expect(clock.pending).toBeLessThanOrEqual(1);
    clock.advance(11_000);
    expect(p.buffer.text()).toBe(text);
    expect(p.getStatus()).toBe("completed");
  });

  it("stop ends playback, keeps partial output, cannot resume, can start again", () => {
    const { clock, p } = make();
    p.start();
    clock.advance(2000);
    expect(p.stop()).toBe(true);
    const partial = p.buffer.text();
    clock.advance(20_000);
    expect(p.buffer.text()).toBe(partial);
    expect(p.getStatus()).toBe("stopped");
    expect(p.resume()).toBe(false);
    expect(p.pause()).toBe(false);
    expect(p.start()).toBe(true);
    clock.advance(10_001);
    expect(p.buffer.text()).toBe(text);
  });

  it("rejects invalid transitions", () => {
    const { p } = make();
    expect(p.pause()).toBe(false);
    expect(p.resume()).toBe(false);
    expect(p.stop()).toBe(false);
    expect(p.restart()).toBe(false);
    p.start();
    expect(p.start()).toBe(false);
    expect(p.resume()).toBe(false);
    expect(p.load("other", null)).toBe(false);
    const statuses = Object.keys(TRANSITIONS);
    for (const tos of Object.values(TRANSITIONS)) for (const to of tos) expect(statuses).toContain(to);
    expect(TRANSITIONS.empty).not.toContain("playing");
    expect(TRANSITIONS.stopped).not.toContain("paused");
    expect(TRANSITIONS.completed).not.toContain("paused");
  });

  it("empty text loads as empty and cannot start", () => {
    const clock = new FakeClock();
    const p = new PlaybackController(clock);
    p.load("", buildTimeline(buildScript("", opts({}, 1)), { timingMode: "speed", durationSec: 1, wpm: 60 }));
    expect(p.getStatus()).toBe("empty");
    expect(p.start()).toBe(false);
  });

  it("late timer callbacks don't cause drift: finish time stays on schedule", () => {
    const { clock, p, tl } = make({ mistakes: "low" }, 10);
    p.start();
    clock.advance(10_500, 45); // every callback fires 45 ms late
    expect(p.getStatus()).toBe("completed");
    expect(p.buffer.text()).toBe(text);
    expect(tl.totalMs).toBeCloseTo(10_000, 3);
  });

  it("reports a mismatch as an error instead of claiming success", () => {
    const clock = new FakeClock();
    const p = new PlaybackController(clock);
    const tl = buildTimeline(buildScript("abc", opts({ mistakes: "off" }, 1)), { timingMode: "duration", durationSec: 1, wpm: 60 });
    p.load("abd", tl); // timeline for a different text
    p.start();
    clock.advance(2000);
    expect(p.getStatus()).toBe("error");
    expect(p.getSnapshot().error).toMatch(/character 3/);
  });

  it("current typing rate is close to the effective speed", () => {
    const long = TEXTS.long.slice(0, 3000);
    const clock = new FakeClock();
    const p = new PlaybackController(clock);
    const tl = buildTimeline(buildScript(long, opts({ rhythm: false, pauses: false, mistakes: "off" }, 1)), { timingMode: "speed", durationSec: 0, wpm: 80 });
    p.load(long, tl);
    p.start();
    clock.advance(30_000);
    p.refresh();
    expect(p.getSnapshot().currentWpm).toBeGreaterThan(75);
    expect(p.getSnapshot().currentWpm).toBeLessThan(85);
  });
});

describe("performance", () => {
  it("builds a plan for 100k characters quickly", () => {
    const text = TEXTS.long.repeat(4).slice(0, 100_000);
    const t0 = performance.now();
    const script = buildScript(text, opts({ mistakes: "medium" }, 1));
    const tl = buildTimeline(script, { timingMode: "speed", durationSec: 0, wpm: 60 });
    const ms = performance.now() - t0;
    expect(tl.events.length).toBeGreaterThan(100_000);
    expect(ms).toBeLessThan(3000);
    const buf = new TypedBuffer();
    for (const e of tl.events) buf.apply(e);
    expect(buf.text()).toBe(text);
  });
});
