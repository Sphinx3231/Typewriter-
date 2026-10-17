import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, LIMITS, normalizeSettings, realismKey, validateSettings, type PlaybackSettings } from "./settings";

const fields = (s: Partial<PlaybackSettings>) => validateSettings({ ...DEFAULT_SETTINGS, ...s }).map((i) => i.field);
const messages = (s: Partial<PlaybackSettings>) => validateSettings({ ...DEFAULT_SETTINGS, ...s }).map((i) => i.message);

describe("validateSettings", () => {
  it("duration mode checks the duration, not the speed", () => {
    const d = { timingMode: "duration" as const, wpm: -1 };
    expect(fields({ ...d, durationSec: 1 })).toEqual([]);
    expect(fields({ ...d, durationSec: LIMITS.durationSec.max })).toEqual([]);
    expect(messages({ ...d, durationSec: 0.5 })).toEqual(["Set a duration of at least 1 second."]);
    expect(messages({ ...d, durationSec: Number.NaN })).toEqual(["Set a duration of at least 1 second."]);
    expect(messages({ ...d, durationSec: Number.POSITIVE_INFINITY })).toEqual(["Set a duration of at least 1 second."]);
    expect(messages({ ...d, durationSec: LIMITS.durationSec.max + 1 })).toEqual(["Duration can be at most 24 hours."]);
    expect(fields({ ...d, durationSec: LIMITS.durationSec.max + 1 })).toEqual(["durationSec"]);
  });

  it("speed mode checks the speed, not the duration", () => {
    const s = { timingMode: "speed" as const, durationSec: -1 };
    expect(fields({ ...s, wpm: 5 })).toEqual([]);
    expect(fields({ ...s, wpm: 400 })).toEqual([]);
    expect(messages({ ...s, wpm: 4 })).toEqual(["Set a speed of at least 5 WPM."]);
    expect(messages({ ...s, wpm: Number.NaN })).toEqual(["Set a speed of at least 5 WPM."]);
    expect(messages({ ...s, wpm: 401 })).toEqual(["Speed can be at most 400 WPM."]);
  });

  it("correction delays must be finite, inside 50 ms..5 s and ordered", () => {
    const range = "Correction delay must be between 50 ms and 5 s.";
    expect(messages({ correctionDelayMinMs: 50, correctionDelayMaxMs: 5000 })).toEqual([]);
    expect(messages({ correctionDelayMinMs: 49 })).toEqual([range]);
    expect(messages({ correctionDelayMaxMs: 5001 })).toEqual([range]);
    expect(messages({ correctionDelayMinMs: Number.NaN })).toEqual([range]);
    expect(messages({ correctionDelayMaxMs: Number.NaN })).toEqual([range]);
    expect(messages({ correctionDelayMinMs: 800, correctionDelayMaxMs: 700 })).toEqual([
      "The shortest correction delay can't be longer than the longest.",
    ]);
    expect(fields({ correctionDelayMinMs: 800, correctionDelayMaxMs: 700 })).toEqual(["correctionDelayMinMs"]);
  });

  it("reports timing and delay problems together", () => {
    expect(fields({ timingMode: "duration", durationSec: 0, correctionDelayMinMs: 10 })).toEqual(["durationSec", "correctionDelayMinMs"]);
  });
});

describe("normalizeSettings", () => {
  it("returns a fresh copy of the defaults for missing or non-object input", () => {
    for (const raw of [undefined, null, 0, "settings", true]) {
      const s = normalizeSettings(raw);
      expect(s).toEqual(DEFAULT_SETTINGS);
      expect(s).not.toBe(DEFAULT_SETTINGS);
    }
  });

  it("keeps every valid saved field", () => {
    const saved: PlaybackSettings = {
      timingMode: "duration",
      durationSec: 300,
      wpm: 90,
      rhythm: false,
      variation: "high",
      mistakes: "medium",
      correction: "autocorrect",
      correctionDelayMinMs: 100,
      correctionDelayMaxMs: 900,
      pauses: false,
      sound: true,
      seed: 42,
    };
    expect(normalizeSettings(saved)).toEqual(saved);
  });

  it("replaces malformed fields with defaults and ignores unknown ones", () => {
    const s = normalizeSettings({
      timingMode: "fast",
      durationSec: "120",
      wpm: Number.POSITIVE_INFINITY,
      rhythm: 1,
      variation: "extreme",
      mistakes: null,
      correction: 7,
      correctionDelayMinMs: Number.NaN,
      correctionDelayMaxMs: {},
      pauses: "yes",
      sound: "true",
      seed: "abc",
      extra: "ignored",
    });
    expect(s).toEqual(DEFAULT_SETTINGS);
    expect(s).not.toHaveProperty("extra");
  });

  it("fills in fields missing from older saved preferences", () => {
    expect(normalizeSettings({ wpm: 120, sound: true })).toEqual({ ...DEFAULT_SETTINGS, wpm: 120, sound: true });
  });
});

describe("realismKey", () => {
  it("changes with settings that alter the keystroke sequence", () => {
    const base = realismKey(DEFAULT_SETTINGS);
    const changes: Partial<PlaybackSettings>[] = [
      { rhythm: false },
      { variation: "high" },
      { mistakes: "off" },
      { correction: "backspace" },
      { correctionDelayMinMs: 300 },
      { correctionDelayMaxMs: 900 },
      { pauses: false },
      { seed: 1 },
    ];
    for (const c of changes) expect(realismKey({ ...DEFAULT_SETTINGS, ...c })).not.toBe(base);
  });

  it("ignores sound and timing", () => {
    const base = realismKey(DEFAULT_SETTINGS);
    expect(realismKey({ ...DEFAULT_SETTINGS, sound: true, wpm: 200, durationSec: 5, timingMode: "duration" })).toBe(base);
  });
});
