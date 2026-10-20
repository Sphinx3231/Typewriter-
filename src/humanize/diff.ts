/**
 * The Humanization Studio's diff: what changed between the original and the prepared copy.
 *
 * A presentation layer only. Nothing here produces text to type except `applyReverts`, and that
 * only stitches together exact slices of the two texts. Every segment's `before` is a slice of
 * the original and every `after` a slice of the revised text, so joining the segments always gives
 * back both texts exactly.
 *
 * The diff runs on word-level tokens (Unicode word segmentation, so punctuation, spaces, line
 * breaks, emoji and combining marks are tokens of their own and never split), first line by line
 * and then inside changed lines. That keeps long documents fast and highlights single words, not
 * whole paragraphs.
 */
import type { Edit } from ".";

export type ChangeType =
  /** Wording that is only in the revised text. */
  | "added"
  /** Wording that is only in the original. */
  | "removed"
  /** Wording swapped for other wording. */
  | "replaced"
  /** Only punctuation differs. */
  | "punctuation"
  /** Only spaces or line breaks differ. */
  | "formatting"
  /** Only upper/lower case differs. */
  | "case";

export interface Change {
  /** 0-based, in text order. */
  id: number;
  type: ChangeType;
  /** Exact slice of the original (empty for an addition). */
  before: string;
  /** Exact slice of the revised text (empty for a removal). */
  after: string;
  origStart: number;
  origEnd: number;
  revStart: number;
  revEnd: number;
}

export type Segment = { kind: "same"; text: string; origStart: number; revStart: number } | ({ kind: "change" } & Change);

export interface DiffStats {
  changes: number;
  wordsRemoved: number;
  wordsAdded: number;
  /** For each change, the larger of the words removed and the words added, summed. */
  wordsChanged: number;
  /** Sentences of the revised text that contain a change (or the spot of a removal). */
  sentencesAdjusted: number;
}

export interface TextDiff {
  original: string;
  revised: string;
  segments: Segment[];
  changes: Change[];
  stats: DiffStats;
}

// ---------------------------------------------------------------- tokens

const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "word" }) : null;
const WORDLIKE = /[\p{L}\p{N}]/u;

/** Words, runs of spaces, line breaks and single punctuation marks; never splits a character. */
export function tokenize(text: string): string[] {
  if (!text) return [];
  if (segmenter) return Array.from(segmenter.segment(text), (s) => s.segment);
  /* c8 ignore next */
  return text.match(/[\p{L}\p{N}\p{M}'’-]+|[ \t]+|\r\n|[\s\S]/gu) ?? [];
}

const wordsOf = (t: string) => t.toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}'’-]*/gu) ?? [];
const countWords = (text: string) => tokenize(text).filter((t) => WORDLIKE.test(t)).length;

// ---------------------------------------------------------------- Myers

type Op = 0 | 1 | 2; // same, delete (original only), insert (revised only)

/**
 * Myers' O((N+M)·D) shortest edit script over interned tokens. Returns null when the
 * difference exceeds `maxD`, so a caller can fall back to a coarser (still exact) answer.
 */
function myers(a: Int32Array, b: Int32Array, maxD: number): Op[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxD);
  const off = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    // Only diagonals -d-1..d+1 are read back for this step: O(D²) memory, not O(D·(N+M)).
    trace.push(v.slice(off - d - 1, off + d + 2));
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      next[off + k] = x;
      if (x >= n && y >= m) {
        return backtrack(trace, n, m);
      }
    }
    v = next;
  }
  return null;
}

function backtrack(trace: Int32Array[], n: number, m: number): Op[] {
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d];
    const at = (k: number) => v[k + d + 1];
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const pk = down ? k + 1 : k - 1;
    const px = d === 0 ? 0 : at(pk);
    const py = px - pk;
    while (x > px && y > py) {
      ops.push(0);
      x--;
      y--;
    }
    if (d > 0) {
      ops.push(down ? 2 : 1);
      if (down) y--;
      else x--;
    }
  }
  return ops.reverse();
}

// ---------------------------------------------------------------- diff

const MAX_D = 1500;

interface Piece {
  op: Op;
  text: string;
}

function intern(lists: string[][]): Int32Array[] {
  const ids = new Map<string, number>();
  return lists.map((l) => Int32Array.from(l, (t) => ids.get(t) ?? (ids.set(t, ids.size), ids.size - 1)));
}

/**
 * A removal or addition between identical tokens can often sit in several places ("tools␠in␠order␠to"
 * minus "in␠order␠" or minus "␠in␠order"). Slide each one to the place that starts at a word and
 * ends with a space, so changes read as whole words. Only the labels move; the text is unchanged.
 */
function slide(p: Piece[]) {
  const score = (s: number, e: number) => (WORDLIKE.test(p[s].text) ? 2 : 0) + (/^\s+$/.test(p[e - 1].text) ? 1 : 0);
  for (let s = 0; s < p.length; s++) {
    const op = p[s].op;
    if (op === 0) continue;
    let e = s;
    while (e < p.length && p[e].op === op) e++;
    if ((s > 0 && p[s - 1].op !== 0) || (e < p.length && p[e].op !== 0)) {
      s = e - 1;
      continue;
    }
    while (s > 0 && p[s - 1].op === 0 && p[s - 1].text === p[e - 1].text) {
      p[s - 1].op = op;
      p[e - 1].op = 0;
      s--;
      e--;
    }
    let best = s;
    let bestScore = score(s, e);
    // Slide right while the run stays between unchanged tokens.
    while (e < p.length && p[e].op === 0 && p[e].text === p[s].text && (e + 1 === p.length || p[e + 1].op === 0)) {
      p[s].op = 0;
      p[e].op = op;
      s++;
      e++;
      const sc = score(s, e);
      if (sc > bestScore) {
        best = s;
        bestScore = sc;
      }
    }
    while (s > best) {
      p[s - 1].op = op;
      p[e - 1].op = 0;
      s--;
      e--;
    }
    s = e - 1;
  }
}

/**
 * Diff two token lists. A difference too large for MAX_D (a long one-paragraph text with many
 * small edits) is split into sentences and diffed sentence by sentence; only if that also fails
 * does it become one replacement. Every path is exact.
 */
function diffTokens(a: string[], b: string[], out: Piece[], depth = 0) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const [ia, ib] = intern([am, bm]);
  const ops = am.length && bm.length ? myers(ia, ib, MAX_D) : null;
  const p: Piece[] = a.slice(0, pre).map((text) => ({ op: 0 as Op, text }));
  if (ops) {
    let i = 0;
    let j = 0;
    for (const op of ops) p.push({ op, text: op === 2 ? bm[j++] : (j += op === 0 ? 1 : 0, am[i++]) });
  } else if (!(am.length && bm.length && depth < 2 && bySentence(am.join(""), bm.join(""), p, depth))) {
    if (am.length) p.push({ op: 1, text: am.join("") });
    if (bm.length) p.push({ op: 2, text: bm.join("") });
  }
  for (const text of a.slice(a.length - suf)) p.push({ op: 0, text });
  slide(p);
  // One at a time: spreading a large array into push() overflows the call stack.
  for (const piece of p) out.push(piece);
}

/** Sentences (each with its trailing spaces) and lines; joined, they give back the text exactly. */
function sentencesOf(text: string): string[] {
  const out: string[] = [];
  let last = 0;
  for (const m of text.matchAll(/[.!?…]+["'”’)\]]*\s+|\n/g)) {
    const end = m.index + m[0].length;
    out.push(text.slice(last, end));
    last = end;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * Diff sentence by sentence. The rewrite edits inside sentences, so the counts usually match and
 * sentence i pairs with sentence i; otherwise the sentences are aligned with Myers first. Returns
 * false (nothing pushed) when neither gives a finer answer than one whole replacement.
 */
function bySentence(x: string, y: string, out: Piece[], depth: number): boolean {
  const sa = sentencesOf(x);
  const sb = sentencesOf(y);
  if (sa.length < 2 && sb.length < 2) return false;
  const pair = (u: string[], w: string[]) => {
    const s = u.join("");
    const t = w.join("");
    if (s === t) out.push({ op: 0, text: s });
    else diffTokens(tokenize(s), tokenize(t), out, depth + 1);
  };
  if (sa.length === sb.length) {
    for (let i = 0; i < sa.length; i++) pair([sa[i]], [sb[i]]);
    return true;
  }
  const [ia, ib] = intern([sa, sb]);
  const ops = myers(ia, ib, MAX_D);
  if (!ops || !ops.includes(0)) return false;
  let i = 0;
  let j = 0;
  let del: string[] = [];
  let ins: string[] = [];
  const flush = () => {
    if (del.length || ins.length) pair(del, ins);
    del = [];
    ins = [];
  };
  for (const op of ops) {
    if (op === 0) {
      flush();
      out.push({ op: 0, text: sa[i++] });
      j++;
    } else if (op === 1) del.push(sa[i++]);
    else ins.push(sb[j++]);
  }
  flush();
  return true;
}

const lines = (t: string) => t.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/** Blocks larger than this (both texts' characters together) are split into sentences first. */
const SENTENCE_FIRST = 50_000;

/**
 * Diff a block of text. A very large block (a long one-paragraph document) goes sentence by
 * sentence straight away: word-splitting and diffing it whole would fail MAX_D anyway, after
 * seconds of work, and then every sentence would be split into words a second time.
 */
function diffBlock(x: string, y: string, out: Piece[]) {
  if (x && y && x.length + y.length > SENTENCE_FIRST && bySentence(x, y, out, 0)) return;
  diffTokens(tokenize(x), tokenize(y), out);
}

function diffPieces(original: string, revised: string): Piece[] {
  const out: Piece[] = [];
  const la = lines(original);
  const lb = lines(revised);
  const [ia, ib] = intern([la, lb]);
  const ops = myers(ia, ib, MAX_D);
  if (!ops) {
    diffBlock(original, revised, out);
    return out;
  }
  // Same lines stay whole; each run of changed lines is diffed word by word.
  let i = 0;
  let j = 0;
  let del: string[] = [];
  let ins: string[] = [];
  const flush = () => {
    if (del.length || ins.length) diffBlock(del.join(""), ins.join(""), out);
    del = [];
    ins = [];
  };
  for (const op of ops) {
    if (op === 0) {
      flush();
      out.push({ op: 0, text: la[i++] });
      j++;
    } else if (op === 1) del.push(la[i++]);
    else ins.push(lb[j++]);
  }
  flush();
  return out;
}

const ONLY_SPACE = /^\s*$/;

function classify(before: string, after: string): ChangeType {
  if (ONLY_SPACE.test(before) && ONLY_SPACE.test(after)) return "formatting";
  if (!WORDLIKE.test(before) && !WORDLIKE.test(after)) return "punctuation";
  if (before.toLocaleLowerCase() === after.toLocaleLowerCase()) return "case";
  if (!WORDLIKE.test(before) && !before.trim()) return "added";
  if (!WORDLIKE.test(after) && !after.trim()) return "removed";
  return "replaced";
}

/** Sentence start offsets in `text` (a new sentence after . ! ? … and closing marks, and after a line break). */
function sentenceStarts(text: string): number[] {
  const starts = [0];
  for (const m of text.matchAll(/[.!?…]+["'”’)\]]*\s+|\n+/gu)) starts.push(m.index! + m[0].length);
  return starts;
}

function sentenceIndex(starts: number[], pos: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** A run of the diff: unchanged text (before === after) or one change. */
type Run = { same: boolean; before: string; after: string };

const RESPLIT_MAX_CUTS = 16;

/**
 * For [change][space][change], the pair of spaces (one in each text) whose halves share the most
 * words, as three new runs; null to keep the current split. Each half's words are counted once
 * per space, so the search is (spaces before × spaces after) set lookups, not a recount each time.
 */
function resplit(prev: Run, gap: Run, next: Run): [Run, Run, Run] | null {
  const before = prev.before + gap.before + next.before;
  const after = prev.after + gap.after + next.after;
  const cuts = (t: string) => Array.from(t.matchAll(/[ \t]+/g), (m) => [m.index!, m.index! + m[0].length]).filter(([s, e]) => s > 0 && e < t.length);
  const cb = cuts(before);
  const ca = cuts(after);
  if (!cb.length || !ca.length || cb.length > RESPLIT_MAX_CUTS || ca.length > RESPLIT_MAX_CUTS) return null;
  const halves = (t: string, c: number[]) => [wordsOf(t.slice(0, c[0])), wordsOf(t.slice(c[1]))];
  const shared = (x: string[], y: string[]) => {
    const w = new Set(x);
    let n = 0;
    for (const v of y) if (w.has(v)) n++;
    return n;
  };
  const rate = (hb: string[][], ha: string[][]) => shared(hb[0], ha[0]) + shared(hb[1], ha[1]);
  const hb = cb.map((c) => halves(before, c));
  const ha = ca.map((c) => halves(after, c));
  const now = [prev.before.length, prev.before.length + gap.before.length];
  const nowA = [prev.after.length, prev.after.length + gap.after.length];
  let best = { b: now, a: nowA, score: rate(halves(before, now), halves(after, nowA)) };
  for (let i = 0; i < cb.length; i++)
    for (let j = 0; j < ca.length; j++) {
      if (before.slice(cb[i][0], cb[i][1]) !== after.slice(ca[j][0], ca[j][1])) continue;
      const sc = rate(hb[i], ha[j]);
      if (sc > best.score) best = { b: cb[i], a: ca[j], score: sc };
    }
  if (best.b === now) return null;
  const space = before.slice(best.b[0], best.b[1]);
  return [
    { same: false, before: before.slice(0, best.b[0]), after: after.slice(0, best.a[0]) },
    { same: true, before: space, after: space },
    { same: false, before: before.slice(best.b[1]), after: after.slice(best.a[1]) },
  ];
}

export function diffText(original: string, revised: string): TextDiff {
  const pieces = original === revised ? [{ op: 0 as Op, text: original }] : diffPieces(original, revised);

  // Group: a change is a run of deletions and insertions.
  const runs: Run[] = [];
  for (const p of pieces) {
    if (!p.text) continue;
    const last = runs[runs.length - 1];
    const same = p.op === 0;
    if (last && last.same === same) {
      if (p.op !== 2) last.before += p.text;
      if (p.op !== 1) last.after += p.text;
    } else runs.push({ same, before: p.op === 2 ? "" : p.text, after: p.op === 1 ? "" : p.text });
  }
  // The passes below rebuild the list in one sweep each (no splice inside a loop), so documents
  // with tens of thousands of changes stay linear.

  // Myers may anchor on a lone space inside one edit ("In␠today's…technology" → "Technology" can
  // come out as In→Technology, ␠, today's…technology→∅). Join two changes across a space-only gap
  // when one of them is a pure removal or addition; two real replacements next to each other
  // ("schools" and "commence") stay separate.
  const oneSided = (r: Run) => !r.before || !r.after;
  const isGap = (r: Run) => r.same && /^[ \t]+$/.test(r.before);
  const joined: Run[] = [];
  for (const next of runs) {
    const n = joined.length;
    const gap = joined[n - 1];
    const prev = joined[n - 2];
    if (n >= 2 && !next.same && isGap(gap) && !prev.same && (oneSided(prev) || oneSided(next))) {
      joined.length = n - 2;
      joined.push({ same: false, before: prev.before + gap.before + next.before, after: prev.after + gap.after + next.after });
    } else joined.push(next);
  }
  // Two replacements separated by one space can be split at the wrong space ("Additionally," →
  // "Schools" and "it … schools commence" → "start"). Re-split at the pair of spaces whose halves
  // share the most words ("… schools" → "Schools", "commence" → "start"). Any split is exact.
  // Only for edits of up to RESPLIT_MAX_CUTS spaces a side: the search compares every pair of
  // spaces, and longer edits (which the rewrite rules never make) keep Myers' split.
  for (let r = 1; r < joined.length - 1; r++) {
    const [prev, gap, next] = [joined[r - 1], joined[r], joined[r + 1]];
    if (!(isGap(gap) && !prev.same && !next.same)) continue;
    const better = resplit(prev, gap, next);
    if (better) [joined[r - 1], joined[r], joined[r + 1]] = better;
  }
  // Whitespace both sides share at a change's edges belongs to the unchanged text; then
  // neighbouring unchanged runs merge.
  const tidy: Run[] = [];
  const add = (run: Run) => {
    const last = tidy[tidy.length - 1];
    if (run.same && last?.same) {
      last.before += run.before;
      last.after += run.after;
    } else tidy.push(run);
  };
  for (const c of joined) {
    if (c.same) {
      add(c);
      continue;
    }
    let lead = 0;
    while (lead < c.before.length && lead < c.after.length && c.before[lead] === c.after[lead] && /\s/.test(c.before[lead])) lead++;
    let tail = 0;
    while (
      tail < c.before.length - lead &&
      tail < c.after.length - lead &&
      c.before[c.before.length - 1 - tail] === c.after[c.after.length - 1 - tail] &&
      /\s/.test(c.before[c.before.length - 1 - tail])
    )
      tail++;
    if (lead) add({ same: true, before: c.before.slice(0, lead), after: c.before.slice(0, lead) });
    add({ same: false, before: c.before.slice(lead, c.before.length - tail), after: c.after.slice(lead, c.after.length - tail) });
    if (tail) add({ same: true, before: c.before.slice(c.before.length - tail), after: c.before.slice(c.before.length - tail) });
  }

  const segments: Segment[] = [];
  const changes: Change[] = [];
  let o = 0;
  let v = 0;
  for (const r of tidy) {
    if (r.same) segments.push({ kind: "same", text: r.before, origStart: o, revStart: v });
    else {
      const c: Change = {
        id: changes.length,
        type: classify(r.before, r.after),
        before: r.before,
        after: r.after,
        origStart: o,
        origEnd: o + r.before.length,
        revStart: v,
        revEnd: v + r.after.length,
      };
      changes.push(c);
      segments.push({ kind: "change", ...c });
    }
    o += r.before.length;
    v += r.after.length;
  }

  const starts = sentenceStarts(revised);
  const touched = new Set<number>();
  let wordsRemoved = 0;
  let wordsAdded = 0;
  let wordsChanged = 0;
  for (const c of changes) {
    const wb = countWords(c.before);
    const wa = countWords(c.after);
    wordsRemoved += wb;
    wordsAdded += wa;
    wordsChanged += Math.max(wb, wa);
    const from = sentenceIndex(starts, c.revStart);
    const to = sentenceIndex(starts, Math.max(c.revStart, c.revEnd - 1));
    for (let s = from; s <= to; s++) touched.add(s);
  }
  return {
    original,
    revised,
    segments,
    changes,
    stats: { changes: changes.length, wordsRemoved, wordsAdded, wordsChanged, sentencesAdjusted: touched.size },
  };
}

/** The revised text with the listed changes put back to the original wording. */
export function applyReverts(diff: TextDiff, reverted: ReadonlySet<number>): string {
  if (!reverted.size) return diff.revised;
  let out = "";
  for (const s of diff.segments) out += s.kind === "same" ? s.text : reverted.has(s.id) ? s.before : s.after;
  return out;
}

// ---------------------------------------------------------------- explanations

const RULE_REASONS: Record<string, string> = {
  "generic-opener": "Removed a stock opening phrase",
  "conclusion-marker": "Removed a stock conclusion phrase",
  "additive-transition": "Removed a repeated transition (an earlier sentence already opens with one)",
  filler: "Removed a phrase that announces a point instead of making it",
  "plain-words": "Simplified an unnecessarily formal expression",
};
export const FALLBACK_REASON = "Wording adjusted for flow";

export interface Explanation {
  /** One or two short sentences. */
  reason: string;
  /** Which recorded edits the change was matched to (empty for the fallback or a punctuation/format change). */
  rules: string[];
}


/**
 * Why a change was made, from the edits the rewrite recorded. A recorded edit explains a change
 * only when its "before" text really occurs in the original over that spot, the occurrences cover
 * the whole removed text, and every word the change adds comes from those edits' "after" text.
 * Anything else gets the plain fallback instead of a guess.
 *
 * `explainer` does the per-text work once, for documents with many changes.
 */
export function explainer(original: string, edits: readonly Edit[]): (change: Change) => Explanation {
  const seen = new Set<string>();
  const unique = edits.filter((e) => {
    const k = `${e.rule}\u0000${e.before}\u0000${e.after}`;
    return e.before && !seen.has(k) && (seen.add(k), true);
  });
  const needles = unique.map((e) => e.before.toLocaleLowerCase());
  const lowered = original.toLocaleLowerCase();
  return (change) => {
    if (change.type === "formatting") return { reason: "Spacing or line breaks adjusted", rules: [] };
    if (change.type === "punctuation") return { reason: "Punctuation adjusted", rules: [] };
    const lo = change.origStart;
    const hi = change.origEnd;
    const covered = new Uint8Array(hi - lo);
    const used: Edit[] = [];
    unique.forEach((e, i) => {
      const needle = needles[i];
      let hit = false;
      for (let at = lowered.indexOf(needle, Math.max(0, lo - needle.length)); at >= 0 && at <= hi; at = lowered.indexOf(needle, at + 1)) {
        const end = at + needle.length;
        const overlaps = hi > lo ? at < hi && end > lo : at <= lo && end >= lo;
        if (!overlaps) continue;
        hit = true;
        for (let p = Math.max(at, lo); p < Math.min(end, hi); p++) covered[p - lo] = 1;
      }
      if (hit) used.push(e);
    });
    const removedCovered = covered.every((c, i) => c === 1 || /\s/.test(change.before[i]));
    const afterWords = new Set(used.flatMap((e) => wordsOf(e.after)));
    const addedGrounded = wordsOf(change.after).every((w) => afterWords.has(w));
    if (!used.length || !removedCovered || !addedGrounded) {
      if (change.type === "case") return { reason: "Capitalization adjusted", rules: [] };
      return { reason: FALLBACK_REASON, rules: [] };
    }
    const rules = [...new Set(used.map((e) => e.rule))];
    const reasons = [...new Set(rules.map((r) => RULE_REASONS[r] ?? FALLBACK_REASON))];
    const capitalized = used.some((e) => /^\p{Lu}/u.test(e.after) && e.rule !== "plain-words");
    return { reason: reasons.join("; ") + (capitalized ? ", and capitalized the next word." : "."), rules };
  };
}

export function explain(change: Change, original: string, edits: readonly Edit[]): Explanation {
  return explainer(original, edits)(change);
}
