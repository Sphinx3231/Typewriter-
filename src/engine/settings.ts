export type TimingMode = "duration" | "speed";
export type Variation = "low" | "medium" | "high";
export type MistakeLevel = "off" | "low" | "medium";
export type CorrectionStyle = "autocorrect" | "backspace" | "mixed";

export interface PlaybackSettings {
  /** Whether the user set a target duration or a target typing speed. */
  timingMode: TimingMode;
  /** Target total duration in seconds (duration mode). */
  durationSec: number;
  /** Target typing speed in words per minute, 1 word = 5 characters (speed mode). */
  wpm: number;
  /** Realistic rhythm: varied keystroke timing. Off gives perfectly even intervals. */
  rhythm: boolean;
  variation: Variation;
  mistakes: MistakeLevel;
  correction: CorrectionStyle;
  /** How long the typist takes to notice a mistake, in milliseconds. */
  correctionDelayMinMs: number;
  correctionDelayMaxMs: number;
  /** Longer pauses after punctuation, between paragraphs and before long words. */
  pauses: boolean;
  sound: boolean;
  /** Seed for the realism randomness. Same seed and text give the same playback. */
  seed: number;
}

export const LIMITS = {
  durationSec: { min: 1, max: 24 * 60 * 60 },
  wpm: { min: 5, max: 400 },
  correctionDelayMs: { min: 50, max: 5000 },
} as const;

export const DEFAULT_SETTINGS: PlaybackSettings = {
  timingMode: "speed",
  durationSec: 120,
  wpm: 60,
  rhythm: true,
  variation: "medium",
  mistakes: "low",
  correction: "mixed",
  correctionDelayMinMs: 250,
  correctionDelayMaxMs: 700,
  pauses: true,
  sound: false,
  seed: 20261016,
};

export interface SettingsIssue {
  field: keyof PlaybackSettings;
  message: string;
}

export function validateSettings(s: PlaybackSettings): SettingsIssue[] {
  const issues: SettingsIssue[] = [];
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  if (s.timingMode === "duration") {
    if (!num(s.durationSec) || s.durationSec < LIMITS.durationSec.min)
      issues.push({ field: "durationSec", message: "Set a duration of at least 1 second." });
    else if (s.durationSec > LIMITS.durationSec.max)
      issues.push({ field: "durationSec", message: "Duration can be at most 24 hours." });
  } else {
    if (!num(s.wpm) || s.wpm < LIMITS.wpm.min)
      issues.push({ field: "wpm", message: `Set a speed of at least ${LIMITS.wpm.min} WPM.` });
    else if (s.wpm > LIMITS.wpm.max) issues.push({ field: "wpm", message: `Speed can be at most ${LIMITS.wpm.max} WPM.` });
  }
  const { min, max } = LIMITS.correctionDelayMs;
  if (!num(s.correctionDelayMinMs) || !num(s.correctionDelayMaxMs) || s.correctionDelayMinMs < min || s.correctionDelayMaxMs > max)
    issues.push({ field: "correctionDelayMinMs", message: `Correction delay must be between ${min} ms and ${max / 1000} s.` });
  else if (s.correctionDelayMinMs > s.correctionDelayMaxMs)
    issues.push({ field: "correctionDelayMinMs", message: "The shortest correction delay can't be longer than the longest." });
  return issues;
}

/** Fills missing or malformed fields (e.g. from older saved preferences) with defaults. */
export function normalizeSettings(raw: unknown): PlaybackSettings {
  const s = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== "object") return s;
  const r = raw as Record<string, unknown>;
  const pick = <K extends keyof PlaybackSettings>(k: K, ok: (v: unknown) => boolean) => {
    if (ok(r[k])) (s as Record<string, unknown>)[k] = r[k];
  };
  const isNum = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  const oneOf = (...xs: string[]) => (v: unknown) => typeof v === "string" && xs.includes(v);
  pick("timingMode", oneOf("duration", "speed"));
  pick("durationSec", isNum);
  pick("wpm", isNum);
  pick("rhythm", (v) => typeof v === "boolean");
  pick("variation", oneOf("low", "medium", "high"));
  pick("mistakes", oneOf("off", "low", "medium"));
  pick("correction", oneOf("autocorrect", "backspace", "mixed"));
  pick("correctionDelayMinMs", isNum);
  pick("correctionDelayMaxMs", isNum);
  pick("pauses", (v) => typeof v === "boolean");
  pick("sound", (v) => typeof v === "boolean");
  pick("seed", isNum);
  return s;
}

/** Settings that change the generated keystroke sequence (sound and timing don't). */
export function realismKey(s: PlaybackSettings): string {
  return [s.rhythm, s.variation, s.mistakes, s.correction, s.correctionDelayMinMs, s.correctionDelayMaxMs, s.pauses, s.seed].join("|");
}
