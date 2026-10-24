/**
 * Writing analysis (SPEC §2a): SlopMonster's checker, run on the user's text, on this device.
 *
 * This is the only engine. It reports findings and never changes the text: what is typed is
 * always the text in the editor. The checker is SlopMonster's tools/deslop.py, ported rule for
 * rule (./slopmonster, MIT); this module turns its hits into findings with their place in the
 * text and an explanation taken from SlopMonster's own documentation (README "What it checks",
 * references/signs-of-ai-writing.md).
 *
 * Not available: SlopMonster's rewriting step (tools/cleanse.sh), which sends the text to an AI
 * model through the codex or claude command-line tools. Typewriter never sends text anywhere.
 */
import { audit, hitsOf, locate, normalise, slopScore, CATEGORIES, type Category, type Hits, type Located } from "./slopmonster";

export type { Category, Hits };
export { CATEGORIES };

export interface Finding {
  /** Position in reading order, from 0. */
  id: number;
  category: Category;
  /** The rule as SlopMonster names it: the word, the construction, or the punctuation rule. */
  rule: string;
  /** What SlopMonster reports for the hit, where it reports more than the rule. */
  detail?: string;
  /** Where it is in the analysed text: [start, end) in UTF-16 units. Several for a rule about the whole text (semicolons). */
  ranges: [number, number][];
  /** The first range's start, for ordering and navigation. */
  start: number;
  /** The analysed text at the first range. */
  excerpt: string;
}

export interface Analysis {
  /** Exactly the text that was analysed. */
  source: string;
  findings: Finding[];
  /** SlopMonster's own report (audit), which the findings reproduce exactly. */
  hits: Hits;
  /** Findings per category. */
  counts: Record<Category, number>;
  /** How long the check took, in milliseconds. */
  ms: number;
}

/** Category names and what each one checks (SlopMonster's README, "What it checks"). */
export const CATEGORY_INFO: Record<Category, { title: string; checks: string }> = {
  vocab: { title: "Vocabulary", checks: "Listed words such as “delve” and “seamless”, including selected word forms." },
  phrases: { title: "Sentence patterns", checks: "Listed constructions such as “not just X, but Y”, stacked hedges and certain self-answering questions." },
  punctuation: {
    title: "Punctuation",
    checks: "Repeated em dashes or stacked hyphenated compounds within a 220-character window in a sentence, plus semicolon density.",
  },
  rhythm: { title: "Three-item lists", checks: "Two specific list patterns that often occur in promotional copy." },
  proof: { title: "Possible unsupported proof", checks: "Numbers near nouns such as “users” or “customers”. The checker cannot verify the claim." },
};

/** The suggested fix for each construction, from SlopMonster's catalogue (references/signs-of-ai-writing.md §2). */
const PHRASE_FIX: Record<string, string> = {
  "the 'not just X, but Y' construction": "Cut the first clause and keep the claim.",
  "the 'not just X, it's Y' construction": "Cut the first clause and keep the claim.",
  "'more than just'": "Cut the first clause and keep the claim.",
  "the 'whether you're X or Y' opener": "Name the one reader you mean.",
  "'that's where X comes in'": "State what X does.",
  "'say goodbye to'": "Name what replaces it.",
  "the 'imagine a…' opener": "Show it instead.",
  "hedged benefit ('helps you to…')": "Describe the benefit at the certainty the evidence supports.",
  "stacked hedging": "Remove redundant hedges while preserving uncertainty.",
  "self-answering question": "Write it as a sentence.",
};

/** Why SlopMonster reports a finding, and what its documentation suggests. */
export function explain(f: Finding): string {
  switch (f.category) {
    case "vocab":
      return `“${f.rule}” is on SlopMonster's list of words to review for vague or promotional use. Keep it where it is the precise or literal word; otherwise say what actually happens. Often a plain word is enough.`;
    case "phrases": {
      const fix = PHRASE_FIX[f.rule];
      return `SlopMonster lists ${f.rule} among the constructions to review.${fix ? ` Its suggestion: ${fix}` : " Check whether the sentence says the same without it."}`;
    }
    case "punctuation":
      if (f.rule.startsWith("two or more em-dashes"))
        return "Two or more em dashes within one sentence window. Check whether the interruptions make it harder to follow. Punctuation can be right even when it triggers a pattern.";
      if (f.rule.includes("hyphenated compounds")) return `${f.rule[0].toUpperCase()}${f.rule.slice(1)} (SlopMonster flags four within one sentence window). Check whether the modifiers help the reader.`;
      return `${f.detail ?? "Many"} semicolons: more than SlopMonster's limit for a text this long (it scales with length). Check whether shorter sentences would read better.`;
    case "rhythm":
      return "A list in one of the two three-item shapes SlopMonster recognizes. Check whether each item adds information; keep a useful list at its natural length.";
    case "proof":
      return "A number next to a word like “users” or “customers”. The checker cannot tell whether the claim is supported: make sure it is real and sourced.";
  }
}

/** SlopMonster's score out of 5: one point off for each category with a finding. With `allowProof`, number claims are still reported but cost nothing (upstream --allow-proof). */
export function score(a: Analysis, allowProof = false): number {
  return slopScore(a.hits, allowProof);
}

/** Analyses `text` with SlopMonster's checker. Throws if the findings don't reproduce SlopMonster's report exactly. */
export function analyze(text: string): Analysis {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const located = locate(text);
  const hits = audit(normalise(text));
  if (JSON.stringify(hitsOf(located)) !== JSON.stringify(hits)) throw new Error("the findings didn't match SlopMonster's report");
  const findings = toFindings(text, located);
  const counts = { vocab: 0, phrases: 0, punctuation: 0, rhythm: 0, proof: 0 } as Record<Category, number>;
  for (const f of findings) counts[f.category]++;
  const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();
  return { source: text, findings, hits, counts, ms: Math.round(t1 - t0) };
}

/** Findings in reading order (start, then end, then category order). */
function toFindings(text: string, located: Located[]): Finding[] {
  const order = (c: Category) => CATEGORIES.indexOf(c);
  const list = located.map((h) => ({ h, start: h.ranges[0]?.[0] ?? 0, end: h.ranges[0]?.[1] ?? 0 }));
  list.sort((x, y) => x.start - y.start || x.end - y.end || order(x.h.category) - order(y.h.category));
  return list.map(({ h, start, end }, id) => ({
    id,
    category: h.category,
    rule: h.rule,
    detail: h.detail,
    ranges: h.ranges,
    start,
    excerpt: text.slice(start, end),
  }));
}

export interface Segment {
  /** The analysed text's [start, end). */
  start: number;
  end: number;
  /** Findings covering this stretch, in id order (empty: no finding here). */
  ids: number[];
}

/**
 * The text cut into stretches that are covered by the same findings, for highlighting. Ranges
 * may overlap (a word inside a phrase). Linear in the text's boundaries: no recursion, no spreads.
 */
export function segments(length: number, findings: Finding[]): Segment[] {
  const opens = new Map<number, number[]>();
  const closes = new Map<number, number[]>();
  const add = (m: Map<number, number[]>, at: number, id: number) => {
    const list = m.get(at);
    if (list) list.push(id);
    else m.set(at, [id]);
  };
  for (const f of findings)
    for (const [a, b] of f.ranges) {
      if (b <= a) continue;
      add(opens, a, f.id);
      add(closes, b, f.id);
    }
  const cuts = new Set<number>([0, length]);
  for (const k of opens.keys()) cuts.add(k);
  for (const k of closes.keys()) cuts.add(k);
  const points = Array.from(cuts).filter((p) => p >= 0 && p <= length);
  points.sort((a, b) => a - b);
  const open = new Map<number, number>(); // id → how many of its ranges are open here
  const out: Segment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p = points[i];
    for (const id of closes.get(p) ?? []) {
      const n = (open.get(id) ?? 0) - 1;
      if (n <= 0) open.delete(id);
      else open.set(id, n);
    }
    for (const id of opens.get(p) ?? []) open.set(id, (open.get(id) ?? 0) + 1);
    const ids = Array.from(open.keys());
    ids.sort((a, b) => a - b);
    out.push({ start: p, end: points[i + 1], ids });
  }
  return out;
}
