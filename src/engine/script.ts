/**
 * Turns the source text into a keystroke script: every key press, pause,
 * temporary typo and correction a person would make while typing it.
 *
 * The script is timing-free: each step carries a relative cost in
 * "keystroke units" plus any fixed milliseconds (correction delays).
 * `schedule.ts` converts it to real times for a target duration or speed.
 *
 * Invariant: applying every step to an empty buffer yields exactly the
 * source text. Typos are only ever introduced by this generator and are
 * always corrected back to the source; the source itself is never edited.
 */
import { hasCase, isLetter, isWhitespace, isWordChar, toGraphemes } from "./graphemes";
import { adjacentKey, PUNCTUATION_SLIPS } from "./keyboard";
import { Rng } from "./rng";
import type { CorrectionStyle, MistakeLevel, PlaybackSettings, Variation } from "./settings";

export type StepKind = "type" | "backspace" | "caret" | "replace" | "wait";

export interface Step {
  kind: StepKind;
  /** type: the grapheme typed at the caret. */
  text?: string;
  /** type: true when this keystroke is part of a temporary mistake. */
  err?: boolean;
  /** caret: absolute caret position after the move. */
  to?: number;
  /** replace: buffer range [start, end) replaced by `replacement`. */
  start?: number;
  end?: number;
  replacement?: string[];
  /** Keystroke cost in units (scaled by the typing speed). */
  u: number;
  /** Extra pause in units before this step (scaled by the typing speed). */
  p: number;
  /** Fixed delay before this step, in ms (not scaled). */
  ms: number;
  /** Part of a correction sequence. */
  fix: boolean;
  /** Source graphemes correctly in place after this step. */
  src: number;
  /** Human-readable description for the activity log. */
  note?: string;
}

export interface Script {
  source: string;
  graphemes: string[];
  steps: Step[];
  /** Units spent typing source characters. */
  keyUnits: number;
  /** Units spent in natural pauses. */
  pauseUnits: number;
  /** Units spent on correction keystrokes. */
  fixUnits: number;
  /** Fixed milliseconds spent noticing mistakes. */
  fixedMs: number;
  mistakes: number;
}

export type RealismOptions = Pick<
  PlaybackSettings,
  "rhythm" | "variation" | "mistakes" | "correction" | "correctionDelayMinMs" | "correctionDelayMaxMs" | "pauses" | "seed"
>;

const SIGMA: Record<Variation, number> = { low: 0.12, medium: 0.25, high: 0.4 };
const WORD_MISTAKE_RATE: Record<MistakeLevel, number> = { off: 0, low: 0.025, medium: 0.06 };
const MIN_WORDS_BETWEEN_MISTAKES = 4;

type MistakeKind = "adjacent" | "double" | "omit" | "transpose" | "case";
type FixMethod = "immediate" | "navigate" | "auto";

interface Mistake {
  kind: MistakeKind;
  typed: string[];
}

function commonPrefix(a: string[], b: string[]): number {
  let k = 0;
  while (k < a.length && k < b.length && a[k] === b[k]) k++;
  return k;
}

function commonSuffix(a: string[], b: string[], prefix: number): number {
  let k = 0;
  while (k < a.length - prefix && k < b.length - prefix && a[a.length - 1 - k] === b[b.length - 1 - k]) k++;
  return k;
}

const quote = (g: string[]) => `“${g.join("")}”`;

export function buildScript(source: string, opts: RealismOptions): Script {
  const G = toGraphemes(source);
  const n = G.length;
  const rhythmRng = new Rng(opts.seed);
  const mistakeRng = new Rng((opts.seed ^ 0xa5a5a5a5) >>> 0);
  const sigma = SIGMA[opts.variation];
  const wordRate = WORD_MISTAKE_RATE[opts.mistakes];
  const steps: Step[] = [];

  let bufLen = 0; // caret is always at the end between words
  let burst = 0;
  let keyUnits = 0;
  let pauseUnits = 0;
  let fixUnits = 0;
  let fixedMs = 0;
  let mistakes = 0;

  const push = (s: Step) => {
    steps.push(s);
    if (s.fix) fixUnits += s.u;
    else keyUnits += s.u;
    pauseUnits += s.p;
    fixedMs += s.ms;
  };

  const keyCost = (g: string): number => {
    if (!opts.rhythm) return 1;
    let f = Math.exp(sigma * rhythmRng.normal() - (sigma * sigma) / 2);
    f = Math.min(3, Math.max(0.3, f));
    if (burst > 0) {
      f *= 0.72;
      burst--;
    }
    // Shifted keys (capitals, most symbols) are a touch slower.
    if ((hasCase(g) && g !== g.toLowerCase()) || /[!@#$%^&*()_+{}|:"<>?~]/.test(g)) f *= 1.15;
    return f;
  };

  /** Natural pause before typing G[k], in units. */
  const pauseBefore = (k: number): number => {
    if (k === 0) return 0;
    const prev = G[k - 1];
    const g = G[k];
    let p = 0;
    if (opts.pauses) {
      if (prev === "\n" || prev === "\r\n") p += G[k - 2] === "\n" || G[k - 2] === "\r\n" ? rhythmRng.range(6, 10) : rhythmRng.range(2, 4);
      else if (/^[.!?…]$/u.test(prev) && isWhitespace(g)) p += rhythmRng.range(2.5, 4.5);
      else if (/^[,;:]$/u.test(prev) && isWhitespace(g)) p += rhythmRng.range(1, 2);
      else if (/^[—–]$/u.test(prev)) p += rhythmRng.range(0.5, 1.2);
    }
    if (opts.rhythm && isWhitespace(prev) && !isWhitespace(g)) p += rhythmRng.range(0.1, 0.5);
    if (opts.rhythm && p >= 1.5) burst = rhythmRng.int(3, 6);
    return p;
  };

  const delayMs = () => Math.round(mistakeRng.range(opts.correctionDelayMinMs, opts.correctionDelayMaxMs));

  const typeKey = (g: string, src: number, extra: Partial<Step> = {}) => {
    push({ kind: "type", text: g, u: keyCost(g), p: 0, ms: 0, fix: false, src, ...extra });
    bufLen++;
  };

  const planMistake = (word: string[]): Mistake | null => {
    const kinds: MistakeKind[] = ["adjacent", "adjacent", "transpose", "double", "omit"];
    if (hasCase(word[0]) && word[0] !== word[0].toLowerCase()) kinds.push("case");
    for (let attempt = 0; attempt < 4; attempt++) {
      const kind = mistakeRng.pick(kinds);
      const typed = word.slice();
      if (kind === "adjacent") {
        const k = mistakeRng.int(1, word.length - 1);
        const adj = adjacentKey(word[k], mistakeRng);
        if (!adj) continue;
        typed[k] = adj;
      } else if (kind === "double") {
        const k = mistakeRng.int(0, word.length - 1);
        typed.splice(k + 1, 0, word[k]);
      } else if (kind === "omit") {
        const k = mistakeRng.int(1, word.length - 2);
        typed.splice(k, 1);
      } else if (kind === "transpose") {
        const k = mistakeRng.int(0, word.length - 2);
        if (word[k] === word[k + 1]) continue;
        typed[k] = word[k + 1];
        typed[k + 1] = word[k];
      } else {
        // Shift held a beat too long ("THe") or released too early ("the").
        if (word.length > 1 && hasCase(word[1]) && word[1] === word[1].toLowerCase() && mistakeRng.chance(0.6)) typed[1] = word[1].toUpperCase();
        else typed[0] = word[0].toLowerCase();
      }
      if (typed.join("") !== word.join("")) return { kind, typed };
    }
    return null;
  };

  const chooseMethod = (style: CorrectionStyle): FixMethod => {
    if (style === "autocorrect") return "auto";
    const r = mistakeRng.next();
    if (style === "backspace") return r < 0.7 ? "immediate" : "navigate";
    return r < 0.35 ? "auto" : r < 0.75 ? "immediate" : "navigate";
  };

  /** Types word G[i..j) with a temporary mistake and its correction. Returns the next source index. */
  const typeWordWithMistake = (i: number, j: number, word: string[], m: Mistake, firstPause: number): number => {
    const T = m.typed;
    const wordStart = bufLen;
    const local: string[] = []; // buffer contents from wordStart, to track source progress
    const srcNow = () => {
      let k = 0;
      while (k < local.length && i + k < n && local[k] === G[i + k]) k++;
      return i + k;
    };
    const p = commonPrefix(T, word);
    const s = commonSuffix(T, word, p);
    const method = chooseMethod(opts.correction);
    mistakes++;

    const typeTyped = (count: number, errFrom: number, errTo: number) => {
      for (let k = 0; k < count; k++) {
        local.push(T[k]);
        const err = k >= errFrom && k < errTo;
        const step: Partial<Step> = { err, p: k === 0 ? firstPause : 0 };
        if (k === p) step.note = `Typo while typing ${quote(word)}`;
        typeKey(T[k], srcNow(), step);
      }
    };
    const fixStep = (s0: Omit<Step, "src" | "fix" | "p" | "ms" | "u"> & Partial<Step>) =>
      push({ u: 0.5, p: 0, ms: 0, fix: true, src: srcNow(), ...s0 } as Step);

    if (method === "immediate") {
      const m2 = Math.min(T.length, p + 1 + mistakeRng.int(0, 2));
      typeTyped(m2, p, Infinity);
      const wrong = m2 - p;
      fixStep({ kind: "wait", u: 0, ms: delayMs(), note: `Noticed the typo in ${quote(T.slice(0, m2))}` });
      for (let b = 0; b < wrong; b++) {
        local.pop();
        bufLen--;
        fixStep({ kind: "backspace", u: b === 0 ? 1 : 0.55 });
      }
      for (let k = p; k < word.length; k++) {
        local.push(word[k]);
        const retyping = k < m2;
        const step: Partial<Step> = { fix: retyping };
        if (k === word.length - 1) step.note = `Corrected to ${quote(word)}`;
        if (retyping) {
          bufLen++;
          push({ kind: "type", text: word[k], u: keyCost(word[k]), p: 0, ms: 0, fix: true, src: srcNow(), note: step.note });
        } else typeKey(word[k], srcNow(), step);
      }
      return j;
    }

    if (method === "auto") {
      typeTyped(T.length, p, T.length - s);
      let next = j;
      if (j < n) {
        local.push(G[j]);
        typeKey(G[j], srcNow(), { p: pauseBefore(j) });
        next = j + 1;
      }
      fixStep({ kind: "wait", u: 0, ms: Math.round(delayMs() * 0.6) });
      local.splice(0, T.length, ...word);
      const delta = word.length - T.length;
      bufLen += delta;
      fixStep({
        kind: "replace",
        start: wordStart,
        end: wordStart + T.length,
        replacement: word.slice(),
        u: 0.3,
        note: `Autocorrected ${quote(T)} to ${quote(word)}`,
      });
      return next;
    }

    // navigate: finish the word, notice, arrow back to the error, fix it in place, then jump back.
    typeTyped(T.length, p, T.length - s);
    fixStep({ kind: "wait", u: 0, ms: delayMs(), note: `Spotted ${quote(T)}, moving back to fix it` });
    const end = bufLen;
    let caret = end;
    for (let k = 0; k < s; k++) {
      caret--;
      fixStep({ kind: "caret", to: caret, u: 0.45 });
    }
    const wrongCount = T.length - s - p;
    for (let b = 0; b < wrongCount; b++) {
      local.splice(caret - wordStart - 1, 1);
      caret--;
      bufLen--;
      fixStep({ kind: "backspace", u: b === 0 ? 0.9 : 0.55 });
    }
    for (let k = p; k < word.length - s; k++) {
      local.splice(caret - wordStart, 0, word[k]);
      caret++;
      bufLen++;
      push({ kind: "type", text: word[k], u: keyCost(word[k]), p: 0, ms: 0, fix: true, src: srcNow() });
    }
    if (s > 0) {
      if (s > 3) fixStep({ kind: "caret", to: bufLen, u: 0.8, note: `Corrected to ${quote(word)}` });
      else
        for (let k = 0; k < s; k++) {
          caret++;
          fixStep({ kind: "caret", to: caret, u: 0.35, note: k === s - 1 ? `Corrected to ${quote(word)}` : undefined });
        }
    } else {
      const last = steps[steps.length - 1];
      last.note = `Corrected to ${quote(word)}`;
    }
    return j;
  };

  let i = 0;
  let wordIndex = 0;
  let lastMistakeWord = -Infinity;
  let charsSinceSlip = 0;

  while (i < n) {
    const g = G[i];
    if (isWordChar(g) && (i === 0 || !isWordChar(G[i - 1]))) {
      let j = i;
      while (j < n && isWordChar(G[j])) j++;
      const word = G.slice(i, j);
      wordIndex++;
      let firstPause = pauseBefore(i);
      if (opts.pauses && word.length >= 8 && rhythmRng.chance(0.3)) firstPause += rhythmRng.range(1.5, 3);

      const eligible =
        wordRate > 0 &&
        wordIndex - lastMistakeWord > MIN_WORDS_BETWEEN_MISTAKES &&
        word.length >= 3 &&
        word.every(isLetter);
      if (eligible && mistakeRng.chance(wordRate)) {
        const m = planMistake(word);
        if (m) {
          lastMistakeWord = wordIndex;
          i = typeWordWithMistake(i, j, word, m, firstPause);
          charsSinceSlip = 0;
          continue;
        }
      }
      for (let k = i; k < j; k++) typeKey(G[k], k + 1, { p: k === i ? firstPause : pauseBefore(k) });
      charsSinceSlip += j - i;
      i = j;
      continue;
    }

    const slips = PUNCTUATION_SLIPS[g];
    if (slips && wordRate > 0 && charsSinceSlip > 60 && mistakeRng.chance(wordRate * 0.6)) {
      const wrong = mistakeRng.pick(slips);
      mistakes++;
      typeKey(wrong, i, { err: true, p: pauseBefore(i), note: `Typo: ${quote([wrong])} instead of ${quote([g])}` });
      push({ kind: "wait", u: 0, p: 0, ms: Math.round(delayMs() * 0.7), fix: true, src: i });
      bufLen--;
      push({ kind: "backspace", u: 1, p: 0, ms: 0, fix: true, src: i });
      bufLen++;
      push({ kind: "type", text: g, u: keyCost(g), p: 0, ms: 0, fix: true, src: i + 1, note: `Corrected to ${quote([g])}` });
      charsSinceSlip = 0;
      i++;
      continue;
    }

    typeKey(g, i + 1, { p: pauseBefore(i) });
    charsSinceSlip++;
    i++;
  }

  return { source, graphemes: G, steps, keyUnits, pauseUnits, fixUnits, fixedMs, mistakes };
}
