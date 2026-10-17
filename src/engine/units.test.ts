import { afterEach, describe, expect, it, vi } from "vitest";
import { buildScript, type Script } from "./script";
import { DEFAULT_SETTINGS } from "./settings";
import { durationForWpm, eventIndexAt, wpmForDuration } from "./schedule";
import { computeStats, EMPTY_STATS, isBlank } from "./stats";
import { hasCase, isLetter, isWhitespace, isWordChar, toGraphemes } from "./graphemes";
import { Rng, randomSeed } from "./rng";
import { FakeClock } from "./testing";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Rng", () => {
  it("is deterministic per seed and maps seed 0 to a fixed non-zero seed", () => {
    const seq = (r: Rng) => Array.from({ length: 5 }, () => r.next());
    expect(seq(new Rng(7))).toEqual(seq(new Rng(7)));
    expect(seq(new Rng(7))).not.toEqual(seq(new Rng(8)));
    expect(seq(new Rng(0))).toEqual(seq(new Rng(0x9e3779b9)));
    // Seeds are treated as unsigned 32-bit values.
    expect(seq(new Rng(-1))).toEqual(seq(new Rng(0xffffffff)));
  });

  it("stays inside the requested ranges", () => {
    const r = new Rng(123);
    for (let i = 0; i < 500; i++) {
      const x = r.next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
      const y = r.range(-2, 3);
      expect(y).toBeGreaterThanOrEqual(-2);
      expect(y).toBeLessThan(3);
      const k = r.int(3, 6);
      expect(Number.isInteger(k)).toBe(true);
      expect(k).toBeGreaterThanOrEqual(3);
      expect(k).toBeLessThanOrEqual(6);
      expect(["a", "b", "c"]).toContain(r.pick(["a", "b", "c"]));
      expect(Number.isFinite(r.normal())).toBe(true);
    }
    expect(r.chance(0)).toBe(false);
    expect(r.chance(1)).toBe(true);
  });

  it("int covers both ends of an inclusive range", () => {
    const r = new Rng(99);
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) seen.add(r.int(1, 3));
    expect([...seen].sort()).toEqual([1, 2, 3]);
  });

  it("normal samples are roughly standard", () => {
    const r = new Rng(5);
    const xs = Array.from({ length: 5000 }, () => r.normal());
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
    expect(Math.abs(mean)).toBeLessThan(0.1);
    expect(variance).toBeGreaterThan(0.9);
    expect(variance).toBeLessThan(1.1);
  });

  it("randomSeed returns an unsigned 32-bit integer derived from Math.random", () => {
    vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValueOnce(0.5).mockReturnValueOnce(0.9999999999);
    expect(randomSeed()).toBe(0);
    expect(randomSeed()).toBe(0x7fffffff);
    const top = randomSeed();
    expect(top).toBeLessThanOrEqual(0xffffffff);
    expect(top).toBeGreaterThan(0xfffffff0);
    vi.restoreAllMocks();
    for (let i = 0; i < 20; i++) {
      const s = randomSeed();
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe("stats", () => {
  it("isBlank is true only for empty or whitespace-only text", () => {
    expect(isBlank("")).toBe(true);
    expect(isBlank(" \n\t\r\n ")).toBe(true);
    expect(isBlank("  a  ")).toBe(false);
    expect(isBlank(".")).toBe(false);
  });

  it("empty text has empty stats; whitespace-only text has characters but no words", () => {
    expect(computeStats("")).toBe(EMPTY_STATS);
    expect(computeStats(" \n ")).toEqual({ characters: 3, charactersNoSpaces: 0, words: 0, lines: 2, paragraphs: 0 });
  });

  it("accepts precomputed graphemes", () => {
    const text = "a 👍🏽";
    expect(computeStats(text, toGraphemes(text))).toEqual({ characters: 3, charactersNoSpaces: 2, words: 2, lines: 1, paragraphs: 1 });
  });
});

describe("graphemes", () => {
  it("classifies characters", () => {
    expect(isLetter("é")).toBe(true);
    expect(isLetter("é")).toBe(true);
    expect(isLetter("1")).toBe(false);
    expect(isWordChar("don’t")).toBe(true);
    expect(isWordChar("a b")).toBe(false);
    expect(isWhitespace("\t\n")).toBe(true);
    expect(isWhitespace("")).toBe(false);
    expect(hasCase("ß")).toBe(true);
    expect(hasCase("日")).toBe(false);
  });

  it("falls back to code points when Intl.Segmenter is unavailable", async () => {
    const intl = Intl as unknown as Record<string, unknown>;
    const original = intl.Segmenter;
    delete intl.Segmenter;
    try {
      vi.resetModules();
      const fallback = await import("./graphemes");
      expect(fallback.toGraphemes("")).toEqual([]);
      expect(fallback.toGraphemes("ab")).toEqual(["a", "b"]);
      // Without segmentation, surrogate pairs stay whole but combining marks split off.
      expect(fallback.toGraphemes("😀é")).toEqual(["😀", "e", "́"]);
    } finally {
      intl.Segmenter = original;
      vi.resetModules();
    }
    // With the segmenter, the same text is two user-perceived characters.
    expect(toGraphemes("😀é")).toEqual(["😀", "é"]);
  });
});

describe("schedule helpers", () => {
  const empty = buildScript("", DEFAULT_SETTINGS);
  const clean = buildScript("hello", { ...DEFAULT_SETTINGS, rhythm: false, pauses: false, mistakes: "off" });
  const withFixedDelay: Script = { ...clean, fixedMs: 2000 };

  it("wpmForDuration is 0 when there is nothing to type or no time left after fixed delays", () => {
    expect(wpmForDuration(empty, 10)).toBe(0);
    expect(wpmForDuration(withFixedDelay, 2)).toBe(0); // budget exactly 0
    expect(wpmForDuration(withFixedDelay, 1)).toBe(0); // negative budget
    // 5 units in 1 s of budget → 12_000 * 5 / 1000 = 60 WPM
    expect(wpmForDuration(withFixedDelay, 3)).toBe(60);
  });

  it("durationForWpm is 0 for an empty script or a non-positive speed", () => {
    expect(durationForWpm(empty, 60)).toBe(0);
    expect(durationForWpm(clean, 0)).toBe(0);
    expect(durationForWpm(clean, -10)).toBe(0);
    expect(durationForWpm(withFixedDelay, 60)).toBe(3);
  });

  it("eventIndexAt finds the last event at or before a time", () => {
    const times = Float64Array.from([100, 200, 200, 300]);
    expect(eventIndexAt(times, 50)).toBe(-1);
    expect(eventIndexAt(times, 100)).toBe(0);
    expect(eventIndexAt(times, 250)).toBe(2);
    expect(eventIndexAt(times, 1e9)).toBe(3);
    expect(eventIndexAt(new Float64Array(0), 10)).toBe(-1);
  });
});

describe("FakeClock", () => {
  it("fires timers in time order regardless of creation order, then flushes frames", () => {
    const c = new FakeClock();
    const log: string[] = [];
    c.setTimeout(() => log.push("A@20"), 20);
    c.setTimeout(() => log.push("B@10"), 10);
    c.setTimeout(() => log.push("C@30"), 30);
    const d = c.setTimeout(() => log.push("D@15"), 15);
    c.clearTimeout(d);
    c.frame(() => log.push("frame"));
    expect(c.pending).toBe(3);
    c.advance(25);
    expect(log).toEqual(["B@10", "A@20", "frame"]);
    expect(c.now()).toBe(25);
    expect(c.pending).toBe(1);
    c.advance(5);
    expect(log).toEqual(["B@10", "A@20", "frame", "C@30"]);
    expect(c.pending).toBe(0);
  });

  it("negative delays fire at the current time; timers set by callbacks run in the same advance", () => {
    const c = new FakeClock();
    const log: number[] = [];
    c.setTimeout(() => {
      log.push(c.now());
      c.setTimeout(() => log.push(c.now()), 5);
    }, -10);
    c.advance(10);
    expect(log).toEqual([0, 5]);
  });

  it("lag delays callbacks and skips those that would land past the end", () => {
    const c = new FakeClock();
    const log: number[] = [];
    c.setTimeout(() => log.push(c.now()), 10);
    c.advance(12, 5); // 10 + 5 = 15 > 12: not yet
    expect(log).toEqual([]);
    c.advance(10, 5); // fires at 15
    expect(log).toEqual([15]);
    expect(c.now()).toBe(22);
  });
});
