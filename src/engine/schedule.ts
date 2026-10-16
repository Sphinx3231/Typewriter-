/**
 * Converts a timing-free keystroke script into a timeline for a target
 * duration or a target typing speed.
 */
import type { Script, Step } from "./script";
import type { PlaybackSettings } from "./settings";

/** Fastest keystroke interval we will schedule (3,000 WPM): about one character per display frame at 240 Hz. */
export const MIN_UNIT_MS = 4;
/** Above this keystroke speed the result no longer looks like a person typing. */
export const HUMAN_MAX_WPM = 220;
const MS_PER_CHAR_AT_1_WPM = 12_000; // 1 word = 5 characters

export type TypingEvent = Step & { at: number };

export interface Estimate {
  /** Milliseconds per keystroke unit. */
  unitMs: number;
  totalMs: number;
  typingMs: number;
  pauseMs: number;
  correctionMs: number;
  /** Words (5 characters) of source per minute over the whole session. */
  effectiveWpm: number;
  /** Keystroke speed in WPM while actually typing. */
  keystrokeWpm: number;
  /** Keystroke speed is beyond what a person could type; realism effects will be hard to see. */
  superhuman: boolean;
  /** Duration that would bring the keystroke speed back to HUMAN_MAX_WPM. */
  humanMinimumMs: number;
  /** Set when the requested duration is too short to fit the text with these realism settings. */
  conflict: null | {
    requestedMs: number;
    minimumMs: number;
    /** Minimum if mistakes and natural pauses are turned off. */
    minimumCleanMs: number;
  };
}

export interface Timeline extends Estimate {
  events: TypingEvent[];
  /** events[i].at, for binary search. */
  times: Float64Array;
}

type Timing = Pick<PlaybackSettings, "timingMode" | "durationSec" | "wpm">;

const totalUnits = (s: Script) => s.keyUnits + s.pauseUnits + s.fixUnits;

export function estimate(script: Script, timing: Timing): Estimate {
  const units = totalUnits(script);
  const chars = script.graphemes.length;
  let unitMs: number;
  let conflict: Estimate["conflict"] = null;
  if (units === 0) unitMs = 0;
  else if (timing.timingMode === "speed") unitMs = MS_PER_CHAR_AT_1_WPM / timing.wpm;
  else {
    const requestedMs = timing.durationSec * 1000;
    unitMs = (requestedMs - script.fixedMs) / units;
    if (unitMs < MIN_UNIT_MS) {
      conflict = {
        requestedMs,
        minimumMs: Math.ceil(units * MIN_UNIT_MS + script.fixedMs),
        minimumCleanMs: Math.ceil(chars * MIN_UNIT_MS),
      };
      unitMs = MIN_UNIT_MS;
    }
  }
  const typingMs = script.keyUnits * unitMs;
  const pauseMs = script.pauseUnits * unitMs;
  const correctionMs = script.fixUnits * unitMs + script.fixedMs;
  const totalMs = units === 0 ? 0 : typingMs + pauseMs + correctionMs;
  const keystrokeWpm = unitMs > 0 ? MS_PER_CHAR_AT_1_WPM / unitMs : 0;
  return {
    unitMs,
    totalMs,
    typingMs,
    pauseMs,
    correctionMs,
    effectiveWpm: totalMs > 0 ? chars / 5 / (totalMs / 60_000) : 0,
    keystrokeWpm,
    superhuman: keystrokeWpm > HUMAN_MAX_WPM,
    humanMinimumMs: Math.ceil(units * (MS_PER_CHAR_AT_1_WPM / HUMAN_MAX_WPM) + script.fixedMs),
    conflict,
  };
}

export function buildTimeline(script: Script, timing: Timing): Timeline {
  const est = estimate(script, timing);
  const events: TypingEvent[] = new Array(script.steps.length);
  const times = new Float64Array(script.steps.length);
  let at = 0;
  script.steps.forEach((s, i) => {
    at += (s.u + s.p) * est.unitMs + s.ms;
    events[i] = { ...s, at };
    times[i] = at;
  });
  return { ...est, totalMs: at, events, times };
}

/** WPM that would make the session last `durationSec`, given this script. */
export function wpmForDuration(script: Script, durationSec: number): number {
  const units = totalUnits(script);
  const budget = durationSec * 1000 - script.fixedMs;
  if (units === 0 || budget <= 0) return 0;
  return (MS_PER_CHAR_AT_1_WPM * units) / budget;
}

/** Session length in seconds at `wpm` keystroke speed, given this script. */
export function durationForWpm(script: Script, wpm: number): number {
  const units = totalUnits(script);
  if (units === 0 || wpm <= 0) return 0;
  return (units * (MS_PER_CHAR_AT_1_WPM / wpm) + script.fixedMs) / 1000;
}

/** Index of the last event at or before `t` (-1 if none). */
export function eventIndexAt(times: Float64Array, t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}
