import { audit as slopAudit, normalise as slopNormalise, type Hits } from "./slopmonster";

/**
 * Smart Humanization (SPEC §2a): a local writing-style checklist and a minimal rule-based
 * rewrite. No model, no network. The score is a style heuristic, never a judgement of who (or
 * what) wrote the text.
 *
 * Five of the checks come from SlopMonster's checker (./slopmonster, MIT), ported to run here.
 *
 * The original is never modified: `humanize` always derives its output from the source it is
 * given, so running it on its own output is never needed (and the UI never does).
 */

export type Tone = "any" | "casual" | "formal";

export type CheckId =
  | "repetitive-wording"
  | "redundant-sentences"
  | "formulaic-transitions"
  | "generic-intro-conclusion"
  | "formal-phrasing"
  | "sentence-structure"
  | "vague-statements"
  | "tone-mismatch"
  // From SlopMonster's checker:
  | "buzzwords"
  | "stock-phrases"
  | "rule-of-three"
  | "punctuation-habits"
  | "numeric-claims";

export interface CheckResult {
  id: CheckId;
  label: string;
  /** Whether the text is long enough (or the setting chosen) for this check to mean anything. */
  applicable: boolean;
  flagged: boolean;
  /** Short, human-readable reasons (e.g. the repeated phrase). Empty when not flagged. */
  evidence: string[];
  /** A note for the writer that never counts toward the score. */
  advisory?: boolean;
  /** Where the check comes from, when it isn't Typewriter's own. */
  source?: "slopmonster";
}

export interface Edit {
  rule: string;
  before: string;
  after: string;
}

export type HumanizeStatus =
  /** Score at or above the threshold, and a lightly edited copy was prepared. */
  | "humanized"
  /** Score below the threshold: unchanged. */
  | "no-change-needed"
  /** Too short, or no applicable check: no score, unchanged. */
  | "too-short"
  /** Score at or above the threshold, but no safe small edit was found: unchanged. */
  | "no-safe-edit"
  /** The engine failed or a safety check failed: the original is typed. */
  | "failed";

export interface HumanizeResult {
  source: string;
  /** What will be typed. Equals `source` unless status is "humanized". */
  output: string;
  status: HumanizeStatus;
  /** Rounded percentage, or null when there is no score. */
  score: number | null;
  flagged: number;
  applicable: number;
  checks: CheckResult[];
  edits: Edit[];
  error?: string;
}

export const THRESHOLD = 50;
export const MIN_WORDS = 40;
export const MIN_SENTENCES = 2;

export const CHECK_LABELS: Record<CheckId, string> = {
  "repetitive-wording": "Repetitive wording",
  "redundant-sentences": "Redundant sentences",
  "formulaic-transitions": "Formulaic transitions",
  "generic-intro-conclusion": "Generic introduction or conclusion",
  "formal-phrasing": "Overly formal or wordy phrasing",
  "sentence-structure": "Repetitive sentence structure",
  "vague-statements": "Vague statements",
  "tone-mismatch": "Mismatch with the chosen tone",
  buzzwords: "Overused buzzwords",
  "stock-phrases": "Stock phrases and constructions",
  "rule-of-three": "Tidy lists of three",
  "punctuation-habits": "Dash, hyphen and semicolon habits",
  "numeric-claims": "Numbers to double-check",
};

/** Checks that are shown as notes and never count toward the score (see SlopMonster below). */
export const ADVISORY: ReadonlySet<CheckId> = new Set(["punctuation-habits", "numeric-claims"]);

// ---------------------------------------------------------------- text helpers

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
const STOP = new Set(
  "a an the and or but if then so of to in on at by for with from as is are was were be been being it its this that these those there their they them he she his her we our you your i me my not no do does did have has had will would can could should may might must than also very just about into over such which who whom what when where why how all any each more most other some only own same too".split(
    " ",
  ),
);

function words(text: string): string[] {
  return (text.match(WORD) ?? []).map((w) => w.toLowerCase());
}

function contentWords(text: string): string[] {
  return words(text).filter((w) => w.length >= 4 && !STOP.has(w));
}

/** Sentences, never spanning a paragraph break. */
function sentences(text: string): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n\s*\n/)) {
    const parts = para.match(/[^.!?…]+(?:[.!?…]+["'”’)\]]*|$)/gu) ?? [];
    for (const p of parts) {
      const t = p.replace(/\s+/g, " ").trim();
      if (words(t).length > 0) out.push(t);
    }
  }
  return out;
}

function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => words(p).length > 0);
}

function countMatches(text: string, patterns: RegExp[]): { count: number; found: string[] } {
  let count = 0;
  const found: string[] = [];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      count += m.length;
      for (const x of m) if (!found.includes(x.toLowerCase())) found.push(x.toLowerCase());
    }
  }
  return { count, found };
}

const per100 = (n: number, total: number) => (total > 0 ? (n * 100) / total : 0);

// ---------------------------------------------------------------- vocabularies

const FORMULAIC_START =
  /^(?:moreover|furthermore|additionally|in addition|what's more|what’s more|consequently|ultimately|notably|importantly|overall|thus|hence|therefore|in conclusion|in summary|to summarize|to sum up|to conclude|firstly|secondly|thirdly|lastly|finally)\b/i;

const GENERIC_OPENER =
  /^(?:in today['’]s\b|in this day and age\b|in the modern (?:world|era|age)\b|since the dawn of\b|throughout (?:human )?history\b|in an (?:increasingly [\w-]+ )?(?:era|age|world)\b|it is (?:widely|generally|commonly) (?:known|accepted|believed)\b|have you ever wondered\b|in recent years\b)/i;

const CONCLUSION_START = /^(?:in conclusion|in summary|to sum up|to summarize|to conclude|all in all|ultimately|overall)\b/i;

const WORDY: RegExp[] = [
  /\bin order to\b/gi,
  /\bdue to the fact that\b/gi,
  /\bowing to the fact that\b/gi,
  /\bin the event that\b/gi,
  /\bprior to\b/gi,
  /\bat this point in time\b/gi,
  /\bin spite of the fact that\b/gi,
  /\bfor the purpose of\b/gi,
  /\b(?:with|in) regard to\b/gi,
  /\ba (?:plethora|myriad|multitude) of\b/gi,
  /\butili[sz](?:e|es|ed|ing|ation)\b/gi,
  /\bcommenc(?:e|es|ed|ing)\b/gi,
  /\bendeavou?r(?:s|ed)? to\b/gi,
  /\bdelv(?:e|es|ed|ing) into\b/gi,
  /\bfacilitat(?:e|es|ed|ing)\b/gi,
  /\bleverag(?:e|es|ed|ing)\b/gi,
  /\bnumerous\b/gi,
  /\bsubsequently\b/gi,
  /\bnevertheless\b/gi,
  /\bheretofore\b/gi,
];

const VAGUE: RegExp[] = [
  /\bvarious\b/gi,
  /\bmany people\b/gi,
  /\bsome (?:experts|people|say)\b/gi,
  /\bit is important to note\b/gi,
  /\bit is worth noting\b/gi,
  /\bplays? an? (?:crucial|vital|key|important|significant|pivotal) role\b/gi,
  /\ba wide (?:range|variety|array) of\b/gi,
  /\bin many ways\b/gi,
  /\bsignificant(?:ly)? (?:impact|effect|role)\b/gi,
  /\bvarious (?:aspects|factors|ways)\b/gi,
  /\bthings like\b/gi,
  /\band so on\b/gi,
  /\betc\b\.?/gi,
  /\bin some cases\b/gi,
];

const INFORMAL: RegExp[] = [
  /\b\p{L}+(?:n['’]t|['’](?:re|ve|ll|d|m))\b/giu,
  /\b(?:it|that|there|what|who|here)['’]s\b/gi,
  /\b(?:gonna|wanna|gotta|kinda|sorta|stuff|okay|ok|guys|lol|yeah|cool|awesome)\b/gi,
  /\ba lot of\b/gi,
  /\breally\b/gi,
];

// ---------------------------------------------------------------- checks

function check(id: CheckId, applicable: boolean, flagged: boolean, evidence: string[] = []): CheckResult {
  return { id, label: CHECK_LABELS[id], applicable, flagged: applicable && flagged, evidence: applicable && flagged ? evidence : [] };
}

/**
 * SlopMonster's five categories as checklist items. Upstream fails a category on any hit (it
 * gates short web pages); here the scored ones need enough of a pattern, and hits that one of
 * Typewriter's own checks already counts are left out, so nothing is counted twice. The limits
 * come from calibration.test.ts (40 public-domain passages, none flagged):
 * - buzzwords and stock phrases: 2 or more (no passage has more than 1);
 * - lists of three: at least one per 150 words (passages have at most one per 228 words);
 * - dash, hyphen and semicolon habits are a note only: they fired on 13 of the 40 passages,
 *   because em-dashes and semicolons are ordinary in essays and fiction;
 * - numbers next to "customers", "users" and the like are a note only: the rewrite never changes
 *   a number, and only the writer knows whether a figure is real.
 */
const OWN_VOCAB = new Set(["leverage", "delve", "in today's"]);
const OWN_PHRASES = new Set(["essay-summary phrasing"]);

function slopChecks(text: string, n: number): CheckResult[] {
  const h: Hits = slopAudit(slopNormalise(text));
  const applicable = n >= MIN_WORDS;
  const sm = (c: CheckResult): CheckResult => ({ ...c, source: "slopmonster", ...(ADVISORY.has(c.id) ? { advisory: true } : {}) });
  const more = (list: string[], max: number) => (list.length > max ? [...list.slice(0, max), `and ${list.length - max} more`] : list);
  const times = (k: string, c: number) => (c > 1 ? `${k} ×${c}` : k);

  const vocab = h.vocab.filter(([w]) => !OWN_VOCAB.has(w));
  const vocabCount = vocab.reduce((a, [, c]) => a + c, 0);
  const phrases = h.phrases.filter(([l]) => !OWN_PHRASES.has(l));
  const phraseCount = phrases.reduce((a, [, c]) => a + c, 0);
  return [
    sm(check("buzzwords", applicable, vocabCount >= 2, [more(vocab.map(([w, c]) => times(`"${w}"`, c)), 6).join(", ")])),
    sm(check("stock-phrases", applicable, phraseCount >= 2, [more(phrases.map(([l, c]) => times(l, c)), 5).join("; ")])),
    sm(check("rule-of-three", applicable, h.rhythm.length >= 1 && h.rhythm.length * 150 >= n, [more(h.rhythm.map(([, m]) => `"${m.replace(/[\s.!?,;:]+$/u, "")}"`), 3).join(", ")])),
    sm(check("punctuation-habits", applicable, h.punctuation.length > 0, more(h.punctuation.map(([rule, d]) => (rule.startsWith("semicolon") ? `${d.replace(" found", "")} semicolons` : `${rule}: "${d}"`)), 3))),
    sm(check("numeric-claims", applicable, h.proof.length > 0, [`${more(h.proof.map((p) => `"${p}"`), 4).join(", ")}: make sure each one is real and sourced`])),
  ];
}

export function runChecks(text: string, tone: Tone = "any"): CheckResult[] {
  const ws = words(text);
  const ss = sentences(text);
  const n = ws.length;
  const out: CheckResult[] = [];

  // Repetitive wording: a 3-word phrase used 3+ times, or one content word making up 5%+ of the text.
  {
    const evidence: string[] = [];
    const tri = new Map<string, number>();
    for (let i = 0; i + 2 < ws.length; i++) {
      const g = ws.slice(i, i + 3);
      if (g.every((w) => STOP.has(w))) continue;
      const k = g.join(" ");
      tri.set(k, (tri.get(k) ?? 0) + 1);
    }
    for (const [k, c] of tri) if (c >= 3) evidence.push(`"${k}" ×${c}`);
    const freq = new Map<string, number>();
    for (const w of contentWords(text)) freq.set(w, (freq.get(w) ?? 0) + 1);
    for (const [w, c] of freq) if (c >= 5 && c / n >= 0.05) evidence.push(`"${w}" ×${c}`);
    out.push(check("repetitive-wording", n >= 60, evidence.length > 0, evidence.slice(0, 3)));
  }

  // Redundant sentences: two sentences sharing most of their content words.
  {
    const evidence: string[] = [];
    const sets = ss.map((s) => new Set(contentWords(s)));
    const limit = Math.min(sets.length, 400);
    outer: for (let i = 0; i < limit; i++) {
      if (sets[i].size < 4) continue;
      for (let j = i + 1; j < Math.min(limit, i + 60); j++) {
        if (sets[j].size < 4) continue;
        let inter = 0;
        for (const w of sets[i]) if (sets[j].has(w)) inter++;
        const jac = inter / (sets[i].size + sets[j].size - inter);
        if (jac >= 0.7) {
          evidence.push(`sentences ${i + 1} and ${j + 1} say nearly the same thing`);
          if (evidence.length >= 2) break outer;
        }
      }
    }
    out.push(check("redundant-sentences", ss.length >= 3, evidence.length > 0, evidence));
  }

  // Formulaic transitions opening sentences.
  {
    const starts = ss.map((s) => s.match(FORMULAIC_START)?.[0]).filter((x): x is string => !!x);
    const flagged = starts.length >= 2 && starts.length / ss.length >= 0.2;
    out.push(check("formulaic-transitions", ss.length >= 3, flagged, [`${starts.length} of ${ss.length} sentences open with ${[...new Set(starts.map((x) => `"${x}"`))].join(", ")}`]));
  }

  // Generic introduction or conclusion.
  {
    const evidence: string[] = [];
    const first = ss[0] ?? "";
    const ps = paragraphs(text);
    const lastPara = ps[ps.length - 1] ?? "";
    if (GENERIC_OPENER.test(first)) evidence.push(`opens with "${first.match(GENERIC_OPENER)![0]}"`);
    if (ss.length >= 3 && CONCLUSION_START.test(lastPara)) evidence.push(`last paragraph opens with "${lastPara.match(CONCLUSION_START)![0]}"`);
    out.push(check("generic-intro-conclusion", ss.length >= 3, evidence.length > 0, evidence));
  }

  // Overly formal or wordy phrasing (not applicable when a formal tone was chosen).
  {
    const { count, found } = countMatches(text, WORDY);
    out.push(check("formal-phrasing", n >= MIN_WORDS && tone !== "formal", count >= 2 && per100(count, n) >= 1, [`${count}× ${found.slice(0, 4).join(", ")}`]));
  }

  // Repetitive sentence structure: very even sentence lengths, or many sentences opening alike.
  {
    const evidence: string[] = [];
    const lens = ss.map((s) => words(s).length);
    if (lens.length >= 5) {
      const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
      const sd = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length);
      if (mean > 0 && sd / mean < 0.3) evidence.push(`sentence lengths are very even (about ${Math.round(mean)} words each)`);
      const firsts = new Map<string, number>();
      for (const s of ss) {
        const w = words(s)[0];
        if (w) firsts.set(w, (firsts.get(w) ?? 0) + 1);
      }
      for (const [w, c] of firsts) if (c >= 3 && c / ss.length >= 0.4) evidence.push(`${c} of ${ss.length} sentences start with "${w}"`);
    }
    out.push(check("sentence-structure", ss.length >= 5, evidence.length > 0, evidence));
  }

  // Vague statements.
  {
    const { count, found } = countMatches(text, VAGUE);
    out.push(check("vague-statements", n >= MIN_WORDS, count >= 2 && per100(count, n) >= 1, [`${count}× ${found.slice(0, 4).join(", ")}`]));
  }

  // Mismatch with the chosen tone (only when one was chosen).
  {
    const evidence: string[] = [];
    if (tone === "casual") {
      const { count } = countMatches(text, WORDY);
      const avg = ss.length ? n / ss.length : 0;
      if (count >= 2 && per100(count, n) >= 1) evidence.push(`${count} formal phrases for a casual tone`);
      if (avg >= 25) evidence.push(`long sentences (about ${Math.round(avg)} words) for a casual tone`);
    } else if (tone === "formal") {
      const { count, found } = countMatches(text, INFORMAL);
      if (count >= 2 && per100(count, n) >= 2) evidence.push(`${count} informal words for a formal tone (${found.slice(0, 4).join(", ")})`);
    }
    out.push(check("tone-mismatch", tone !== "any" && n >= MIN_WORDS, evidence.length > 0, evidence));
  }

  out.push(...slopChecks(text, n));
  return out;
}

/** Flagged applicable checks ÷ applicable checks × 100 (notes not counted); null when no check applies. */
export function score(checks: CheckResult[]): { score: number | null; flagged: number; applicable: number; qualifies: boolean } {
  const scored = checks.filter((c) => !c.advisory);
  const applicable = scored.filter((c) => c.applicable).length;
  const flagged = scored.filter((c) => c.applicable && c.flagged).length;
  if (applicable === 0) return { score: null, flagged, applicable, qualifies: false };
  // Integer comparison, so exactly 50% qualifies without floating-point doubt.
  return { score: Math.round((flagged * 100) / applicable), flagged, applicable, qualifies: flagged * 100 >= THRESHOLD * applicable };
}

// ---------------------------------------------------------------- rewrite

/** Quotations, citations, bracketed text, URLs, e-mail addresses and code: never edited. */
const PROTECTED =
  /"[^"\n]*"|“[^”]*”|«[^»]*»|\([^()\n]*(?:\d|et al)[^()\n]*\)|\[[^\]\n]*\]|`[^`\n]*`|\bhttps?:\/\/\S+|\bwww\.\S+|\S+@\S+\.\S+/giu;

function protectedSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  for (const m of text.matchAll(PROTECTED)) spans.push([m.index!, m.index! + m[0].length]);
  return spans;
}

const capitalize = (s: string) => (s ? s[0].toLocaleUpperCase() + s.slice(1) : s);
const matchCase = (orig: string, repl: string) => (orig && orig[0] === orig[0].toLocaleUpperCase() && orig[0] !== orig[0].toLocaleLowerCase() ? capitalize(repl) : repl);

/** A sentence start: the text start, after a line break, or after . ! ? … (and closing quotes). */
const SS = String.raw`(^|\n[ \t]*|[.!?…]["'”’)\]]*[ \t]+)`;

interface Rule {
  id: string;
  re: RegExp;
  /** Returns the replacement for a match (groups as in String.replace). */
  replace: (m: string, ...groups: string[]) => string;
  /** Only the first n matches (after `skip`) are rewritten. */
  skip?: number;
  /** The first group is the text before the change (a line start or the previous sentence's end). */
  prefixed?: boolean;
}

function wordy(id: string, re: RegExp, to: string | ((m: string) => string)): Rule {
  return { id, re, replace: (m) => matchCase(m, typeof to === "string" ? to : to(m)) };
}

const SUFFIX = (base: string) => (m: string) => {
  const l = m.toLowerCase();
  if (/ing$/.test(l)) return `${base}ing`.replace(/eing$/, "ing");
  if (/ed$/.test(l)) return `${base}ed`.replace(/eed$/, "ed");
  if (/es$/.test(l) || /s$/.test(l)) return `${base}s`;
  return base;
};

function rules(tone: Tone): Rule[] {
  const list: Rule[] = [
    // Generic openers at the start of a paragraph: drop the stock phrase, keep the sentence.
    {
      id: "generic-opener",
      re: new RegExp(
        String.raw`(^|\n[ \t]*)(?:In today['’]s (?:fast-paced |modern |digital |ever-changing |rapidly changing |interconnected )?(?:world|society|age|era|landscape)|In this day and age|In the modern (?:world|era|age)|Since the dawn of (?:time|humanity|civilization)|Throughout (?:human )?history|In recent years),[ \t]+(\p{L}[\p{L}'’-]*)`,
        "gu",
      ),
      replace: (_m, pre, next) => pre + capitalize(next),
      prefixed: true,
    },
    // "In conclusion," and friends at the start of a paragraph.
    {
      id: "conclusion-marker",
      re: /(^|\n[ \t]*)(?:In conclusion|In summary|To sum up|To summarize|To conclude),[ \t]+(\p{L}[\p{L}'’-]*)/gu,
      replace: (_m, pre, next) => pre + capitalize(next),
      prefixed: true,
    },
    // Additive transitions opening a sentence: the first stays, later ones go.
    {
      id: "additive-transition",
      re: new RegExp(SS + String.raw`(?:Moreover|Furthermore|Additionally|In addition|What['’]s more),[ \t]+(\p{L}[\p{L}'’-]*)`, "gu"),
      replace: (_m, pre, next) => pre + capitalize(next),
      prefixed: true,
      skip: 1,
    },
    // Filler that announces a point instead of making it.
    {
      id: "filler",
      re: new RegExp(SS + String.raw`(?:It is (?:important|crucial|worth) (?:to note|noting) that|It should be noted that|Needless to say,)[ \t]+(\p{L}[\p{L}'’-]*)`, "gu"),
      replace: (_m, pre, next) => pre + capitalize(next),
      prefixed: true,
    },
    // The rest of this list puts SlopMonster's editing guidance (prompts/cleanse.txt) into fixed
    // edits, only where the shorter wording means the same in any context. Its other findings
    // ("not just X, but Y", lists of three, buzzwords with a literal sense) need judgement, so
    // the Studio reports them and leaves the wording to the writer.
    // Throat-clearing that opens a sentence: "Here's the thing: you need a plan." → "You need a plan."
    // Only these forms: "Here's the thing." can be literal, "Here's the thing, though…" goes on,
    // and "Let's break it down." can mean a box.
    {
      id: "throat-clearing",
      re: new RegExp(SS + String.raw`(?:Here['’]s the thing:|The truth is(?:,| that))[ \t]+(\p{L}[\p{L}'’-]*)`, "gu"),
      replace: (_m, pre, next) => pre + capitalize(next),
      prefixed: true,
    },
    // Stacked hedges: one qualifier is enough.
    wordy("stacked-hedge", /\b(?:may|could) potentially\b/giu, (m) => m.split(/\s/)[0].toLowerCase()),
    wordy("stacked-hedge", /\bmight possibly\b/giu, "might"),
    // Padding around a word that already says it.
    wordy("intensifier", /\bvery unique\b/giu, "unique"),
    wordy("intensifier", /\bquite literally\b/giu, "literally"),
    wordy("intensifier", /\bmore than just\b/giu, "more than"),
    // Not "helps you to": "it helps you to your seat" needs its "to".
  ];
  if (tone !== "formal") {
    list.push(
      wordy("plain-words", /\bin order to\b/giu, "to"),
      wordy("plain-words", /\b(?:due|owing) to the fact that\b/giu, "because"),
      wordy("plain-words", /\bin the event that\b/giu, "if"),
      wordy("plain-words", /\bprior to\b/giu, "before"),
      wordy("plain-words", /\bat this point in time\b/giu, "now"),
      wordy("plain-words", /\bin spite of the fact that\b/giu, "although"),
      wordy("plain-words", /\bfor the purpose of\b/giu, "for"),
      wordy("plain-words", /\b(?:with|in) regard to\b/giu, "about"),
      wordy("plain-words", /\ba (?:plethora|myriad|multitude) of\b/giu, "many"),
      wordy("plain-words", /\butili[sz]ation\b/giu, "use"),
      wordy("plain-words", /\butili[sz](?:e|es|ed|ing)\b/giu, SUFFIX("use")),
      wordy("plain-words", /\bcommenc(?:e|es|ed|ing)\b/giu, SUFFIX("start")),
      wordy("plain-words", /\bendeavou?r to\b/giu, "try to"),
      wordy("plain-words", /\bdelv(?:e|es|ed|ing) into\b/giu, (m) => `${SUFFIX("look")(m.split(/\s/)[0])} into`),
      wordy("plain-words", /\bnumerous\b/giu, "many"),
      // "leverage" as a verb (followed by what is used, not preceded by an article or the like,
      // which would make it the noun: "the leverage the deal gave them").
      wordy(
        "buzzword",
        /(?<!\b(?:the|a|an|of|their|our|his|her|its|my|your|financial|more|less|some|any|no|much|enough)[ \t]+)\bleverag(?:e|es|ed|ing)\b(?=[ \t]+(?:the|a|an|our|your|their|its|his|her|my|this|that|these|those|existing|many|every|each|all|both|new|data|technology|tools?|AI)\b)/giu,
        SUFFIX("use"),
      ),
      wordy("buzzword", /\bharness(?:es|ed|ing)? the power of\b/giu, (m) => ({ harness: "use", harnesses: "uses", harnessed: "used", harnessing: "using" })[m.split(/\s/)[0].toLowerCase()]!),
    );
  }
  return list;
}

function applyRule(text: string, rule: Rule, edits: Edit[]): string {
  const spans = protectedSpans(text);
  let seen = 0;
  return text.replace(rule.re, (...args) => {
    const m = args[0] as string;
    const offset = args[args.length - 2] as number;
    const groups = args.slice(1, -2) as string[];
    if (spans.some(([a, b]) => offset < b && offset + m.length > a)) return m;
    seen++;
    if (rule.skip && seen <= rule.skip) return m;
    const out = rule.replace(m, ...groups);
    if (out !== m) {
      const cut = rule.prefixed ? groups[0].length : 0;
      edits.push({ rule: rule.id, before: m.slice(cut), after: out.slice(cut) });
    }
    return out;
  });
}

export function rewrite(source: string, tone: Tone = "any"): { text: string; edits: Edit[] } {
  const edits: Edit[] = [];
  let text = source;
  for (const r of rules(tone)) text = applyRule(text, r, edits);
  return { text, edits };
}

/**
 * Everything the rewrite must keep: protected spans (quotes, citations, URLs…), every number,
 * and the line structure. Returns a reason when something differs.
 */
export function safetyProblem(source: string, output: string): string | null {
  const spans = (t: string) => protectedSpans(t).map(([a, b]) => t.slice(a, b));
  if (JSON.stringify(spans(source)) !== JSON.stringify(spans(output))) return "a quotation, citation or link would have changed";
  const nums = (t: string) => t.match(/\p{N}+/gu) ?? [];
  if (JSON.stringify(nums(source)) !== JSON.stringify(nums(output))) return "a number would have changed";
  const lines = (t: string) => (t.match(/\n/g) ?? []).length;
  if (lines(source) !== lines(output)) return "the line breaks would have changed";
  const tail = (t: string) => t.match(/\s*$/)![0];
  const head = (t: string) => t.match(/^\s*/)![0];
  if (tail(source) !== tail(output) || head(source) !== head(output)) return "the surrounding whitespace would have changed";
  return null;
}

// ---------------------------------------------------------------- the whole step

/** The checklist and the rewrite; replaceable in tests. */
export interface Engine {
  runChecks: typeof runChecks;
  rewrite: typeof rewrite;
}
const LOCAL: Engine = { runChecks, rewrite };

export function humanize(source: string, tone: Tone = "any", engine: Engine = LOCAL): HumanizeResult {
  const base = { source, output: source, edits: [] as Edit[] };
  try {
    const n = words(source).length;
    const checks = engine.runChecks(source, tone);
    if (n < MIN_WORDS || sentences(source).length < MIN_SENTENCES) {
      return { ...base, status: "too-short", score: null, flagged: 0, applicable: 0, checks: checks.map((c) => ({ ...c, applicable: false, flagged: false, evidence: [] })) };
    }
    const s = score(checks);
    if (s.score === null) return { ...base, status: "too-short", score: null, flagged: 0, applicable: 0, checks };
    const common = { score: s.score, flagged: s.flagged, applicable: s.applicable, checks };
    if (!s.qualifies) return { ...base, ...common, status: "no-change-needed" };
    const r = engine.rewrite(source, tone);
    if (r.text === source || r.edits.length === 0) return { ...base, ...common, status: "no-safe-edit" };
    const problem = safetyProblem(source, r.text);
    if (problem) return { ...base, ...common, status: "failed", error: `Safety check: ${problem}.` };
    return { ...base, ...common, output: r.text, edits: r.edits, status: "humanized" };
  } catch (e) {
    return { ...base, status: "failed", score: null, flagged: 0, applicable: 0, checks: [], error: e instanceof Error ? e.message : String(e) };
  }
}
