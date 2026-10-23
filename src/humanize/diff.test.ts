import { describe, expect, it } from "vitest";
import { humanize } from ".";
import { applyReverts, diffText, explain, FALLBACK_REASON, tokenize, type Change, type TextDiff } from "./diff";
import { NATURAL, ROBOTIC, ROBOTIC_HUMANIZED } from "./fixtures";

/** Both texts, rebuilt from the segments: the diff must never lose or invent a character. */
function rebuilds(d: TextDiff) {
  let o = "";
  let r = "";
  for (const s of d.segments) {
    if (s.kind === "same") {
      expect(d.original.slice(s.origStart, s.origStart + s.text.length)).toBe(s.text);
      expect(d.revised.slice(s.revStart, s.revStart + s.text.length)).toBe(s.text);
      o += s.text;
      r += s.text;
    } else {
      expect(d.original.slice(s.origStart, s.origEnd)).toBe(s.before);
      expect(d.revised.slice(s.revStart, s.revEnd)).toBe(s.after);
      o += s.before;
      r += s.after;
    }
  }
  expect(o).toBe(d.original);
  expect(r).toBe(d.revised);
  expect(applyReverts(d, new Set())).toBe(d.revised);
  expect(applyReverts(d, new Set(d.changes.map((c) => c.id)))).toBe(d.original);
}
const pairs = (d: TextDiff) => d.changes.map((c) => [c.before, c.after, c.type]);

describe("tokenize", () => {
  it("keeps words, spaces, line breaks, punctuation, emoji and combining marks whole", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("Hi, you\n\nthere.")).toEqual(["Hi", ",", " ", "you", "\n", "\n", "there", "."]);
    const t = "naïve 👨‍👩‍👧‍👦 🇯🇵 é 👍🏽 日本語";
    expect(tokenize(t).join("")).toBe(t);
    for (const g of ["👨‍👩‍👧‍👦", "🇯🇵", "👍🏽", "é"]) expect(tokenize(t).some((tok) => tok.includes(g))).toBe(true);
  });
});

describe("diffText", () => {
  it("no change: one unchanged segment and zero statistics", () => {
    const d = diffText(NATURAL, NATURAL);
    expect(d.changes).toEqual([]);
    expect(d.segments).toEqual([{ kind: "same", text: NATURAL, origStart: 0, revStart: 0 }]);
    expect(d.stats).toEqual({ changes: 0, wordsRemoved: 0, wordsAdded: 0, wordsChanged: 0, sentencesAdjusted: 0 });
    rebuilds(d);
  });

  it("empty texts", () => {
    expect(diffText("", "").changes).toEqual([]);
    rebuilds(diffText("", ""));
    const add = diffText("", "Hello there.");
    expect(pairs(add)).toEqual([["", "Hello there.", "added"]]);
    rebuilds(add);
    const del = diffText("Hello there.", "");
    expect(pairs(del)).toEqual([["Hello there.", "", "removed"]]);
    rebuilds(del);
  });

  it("additions, removals and replacements, word by word, not the whole paragraph", () => {
    const d = diffText("We will utilize many tools in order to learn fast.", "We will use many tools to learn fast.");
    expect(pairs(d)).toEqual([
      ["utilize", "use", "replaced"],
      ["in order ", "", "removed"],
    ]);
    expect(d.stats).toEqual({ changes: 2, wordsRemoved: 3, wordsAdded: 1, wordsChanged: 3, sentencesAdjusted: 1 });
    const add = diffText("The cat sat.", "The black cat sat.");
    expect(pairs(add)).toEqual([["", "black ", "added"]]);
    rebuilds(d);
    rebuilds(add);
  });

  it("joins a multi-word replacement into one change instead of fragments", () => {
    const d = diffText("There is a plethora of options.", "There is many options.");
    expect(pairs(d)).toEqual([["a plethora of", "many", "replaced"]]);
    rebuilds(d);
  });

  it("tells punctuation, spacing and capitalization changes apart", () => {
    expect(pairs(diffText("Wait, what?", "Wait; what?"))).toEqual([[",", ";", "punctuation"]]);
    expect(pairs(diffText("one  two", "one two"))).toEqual([[" ", "", "formatting"]]);
    expect(pairs(diffText("a\nb", "a\n\nb"))).toEqual([["", "\n", "formatting"]]);
    expect(pairs(diffText("go home", "Go home"))).toEqual([["go", "Go", "case"]]);
  });

  it("handles line breaks: an unchanged paragraph stays whole, a changed one is diffed inside", () => {
    const a = "First line stays.\nSecond line will utilize words.\r\nThird stays too.\n";
    const b = "First line stays.\nSecond line will use words.\r\nThird stays too.\n";
    const d = diffText(a, b);
    expect(pairs(d)).toEqual([["utilize", "use", "replaced"]]);
    expect(d.segments[0]).toMatchObject({ kind: "same", text: "First line stays.\nSecond line will " });
    rebuilds(d);
    const moved = diffText("a\nb\nc\n", "a\nc\nb\n");
    rebuilds(moved);
    expect(moved.changes.length).toBeGreaterThan(0);
  });

  it("repeated phrases: changes land on the right occurrence", () => {
    const a = "in order to win, in order to grow, in order to learn";
    const b = "in order to win, to grow, in order to learn";
    const d = diffText(a, b);
    expect(d.changes).toHaveLength(1);
    const c = d.changes[0];
    expect(a.slice(c.origStart, c.origEnd)).toBe(c.before);
    expect(c.origStart).toBeGreaterThan(a.indexOf("win"));
    expect(c.origEnd).toBeLessThanOrEqual(a.indexOf("grow"));
    rebuilds(d);
  });

  it("Unicode around the change is untouched and not split", () => {
    const a = "Café 🎉 naïve: we utilize 👨‍👩‍👧‍👦 日本語 «quotes» — ok.";
    const b = "Café 🎉 naïve: we use 👨‍👩‍👧‍👦 日本語 «quotes» — ok.";
    expect(pairs(diffText(a, b))).toEqual([["utilize", "use", "replaced"]]);
    const emoji = diffText("ok 👍🏽 yes", "ok 👍 yes");
    expect(emoji.changes).toHaveLength(1);
    expect(emoji.changes[0].before).toBe("👍🏽");
    rebuilds(emoji);
  });

  it("the real humanized essay: exact pieces, counts from the diff", () => {
    const d = diffText(ROBOTIC, ROBOTIC_HUMANIZED);
    rebuilds(d);
    expect(pairs(d)).toEqual([
      ["In today's fast-paced world, technology", "Technology", "replaced"],
      ["utilize", "use", "replaced"],
      ["in order ", "", "removed"],
      ["Furthermore, teachers", "Teachers", "replaced"],
      ["leverage numerous", "use many", "replaced"],
      ["in order ", "", "removed"],
      ["Additionally, it is important to note that schools", "Schools", "replaced"],
      ["commence", "start", "replaced"],
      ["In conclusion, technology", "Technology", "replaced"],
    ]);
    // Counted by hand: "fast-paced" is two words; sentences 1, 2, 3, 4 and the last one of the revised text are touched.
    expect(d.stats).toEqual({ changes: 9, wordsRemoved: 27, wordsAdded: 8, wordsChanged: 27, sentencesAdjusted: 5 });
  });

  it("stays exact and fast on a large document", () => {
    const a = (ROBOTIC + "\n\n").repeat(160);
    const b = (ROBOTIC_HUMANIZED + "\n\n").repeat(160);
    const t0 = performance.now();
    const d = diffText(a, b);
    const ms = performance.now() - t0;
    expect(d.changes).toHaveLength(9 * 160);
    rebuilds(d);
    expect(ms).toBeLessThan(2000);
  });

  it("falls back to an exact, coarser change when the difference is huge", () => {
    const words = (seed: number) => Array.from({ length: 4000 }, (_, i) => `w${(i * seed) % 997}`).join(" ");
    const d = diffText(words(7), words(13));
    rebuilds(d);
    expect(d.changes.length).toBeGreaterThan(0);
    // Thousands of different lines: the line pass gives up and the whole text is diffed word by word.
    const lines = (k: string) => Array.from({ length: 1800 }, (_, i) => `${k}${i}`).join("\n");
    const many = diffText(lines("a"), lines("b"));
    rebuilds(many);
    expect(many.changes.length).toBeGreaterThan(0);
  });

  it("a long single-paragraph text is still diffed word by word, not as one whole-text change", () => {
    // Regression: 3000 edited sentences on one line exceeded the word-level limit and the whole
    // text showed up as a single replaced change. Now it is split into sentences first.
    const r = humanize("Moreover, we utilize it in order to learn. ".repeat(3000));
    expect(r.status).toBe("humanized");
    const t0 = performance.now();
    const d = diffText(r.source, r.output);
    const ms = performance.now() - t0;
    rebuilds(d);
    expect(d.changes.length).toBe(8999);
    expect(Math.max(...d.changes.map((c) => c.before.length + c.after.length))).toBeLessThan(20);
    expect(pairs(d).slice(0, 3)).toEqual([
      ["utilize", "use", "replaced"],
      ["in order ", "", "removed"],
      ["Moreover, we", "We", "replaced"],
    ]);
    expect(ms).toBeLessThan(3000);
    // The same with Unicode, emoji and curly quotes in every sentence.
    const u = humanize(Array.from({ length: 1500 }, (_, i) => `Moreover, café 🎉 users utilize “it” in order to learn ${i}. `).join(""));
    const du = diffText(u.source, u.output);
    rebuilds(du);
    expect(du.changes.length).toBeGreaterThan(4000);
    expect(du.changes.every((c) => !c.before.includes("🎉") && !c.after.includes("café"))).toBe(true);
  });

  it("aligns sentences first when one was added or removed, then diffs the changed ones", () => {
    const rewritten = (i: number) => `Entirely different words here number ${i} with several extra tokens added. `;
    const kept = (i: number) => `Sentence ${i} stays exactly the same. `;
    const orig = Array.from({ length: 450 }, (_, i) => (i % 3 === 1 ? `Original wording of line ${i} quite unlike the other one. ` : kept(i))).join("");
    const same = Array.from({ length: 450 }, (_, i) => (i % 3 === 1 ? rewritten(i) : kept(i))).join("");
    for (const rev of [same, same + "One more sentence. "]) {
      const d = diffText(orig, rev);
      rebuilds(d);
      // Each rewritten sentence is its own change(s); unchanged sentences stay unchanged.
      expect(d.changes.length).toBeGreaterThanOrEqual(150);
      expect(d.changes.every((c) => !c.before.includes("stays exactly") && c.before.length < 80)).toBe(true);
    }
    // No sentence in common and different counts: an exact, coarse answer.
    const none = diffText(Array.from({ length: 400 }, (_, i) => rewritten(i)).join(""), Array.from({ length: 401 }, (_, i) => kept(i)).join(""));
    rebuilds(none);
    expect(none.changes.length).toBe(1);
  });

  it("a 500,000-character single paragraph completes without a crash and rebuilds exactly", () => {
    // Regression: pieces were appended with out.push(...pieces), which overflows the call stack
    // past about 120,000 pieces ("Maximum call stack size exceeded").
    const r = humanize("Moreover, we utilize it in order to learn. ".repeat(11_628));
    expect(r.source.length).toBeGreaterThanOrEqual(500_000);
    expect(r.status).toBe("humanized");
    const d = diffText(r.source, r.output);
    rebuilds(d);
    expect(d.changes.length).toBe(3 * 11_628 - 1);
    expect(Math.max(...d.changes.slice(0, 1000).map((c) => c.before.length + c.after.length))).toBeLessThan(20);
  }, 60_000);

  it("three changes in a row split where the words line up, so each restores on its own", () => {
    // Myers alone pairs "Furthermore," with "Teachers" and "teachers" with "use": restoring that
    // second change would give "Teachers teachers many platforms".
    const o = "Furthermore, teachers leverage numerous platforms.";
    const r = "Teachers use many platforms.";
    const d = diffText(o, r);
    rebuilds(d);
    expect(pairs(d)).toEqual([
      ["Furthermore, teachers", "Teachers", "replaced"],
      ["leverage numerous", "use many", "replaced"],
    ]);
    expect(applyReverts(d, new Set([1]))).toBe("Teachers leverage numerous platforms.");
    expect(applyReverts(d, new Set([0]))).toBe("Furthermore, teachers use many platforms.");
    // Unrelated neighbours with no words in common keep Myers' split.
    const plain = diffText("alpha beta gamma end", "one two three end");
    rebuilds(plain);
    expect(plain.changes.length).toBeGreaterThanOrEqual(1);
  });

  it("a large multi-paragraph document (800 paragraphs, 471,000 characters) completes and rebuilds exactly", () => {
    // Regression: the same crash, reached when the line pass gives up and the whole text is diffed.
    const r = humanize((ROBOTIC + "\n\n").repeat(800));
    expect(r.status).toBe("humanized");
    const d = diffText(r.source, r.output);
    rebuilds(d);
    expect(d.changes.length).toBe(10 * 800 - 1);
    expect(pairs(d).slice(0, 9)).toEqual(pairs(diffText(ROBOTIC, ROBOTIC_HUMANIZED)));
  }, 60_000);

  it("two long rewritten sentences side by side don't freeze the re-split pass", () => {
    // Regression: the re-split tried every pair of spaces and recounted words for each pair, so
    // two 751-word replacements next to each other ran for minutes. Now bounded; still exact.
    const s = (p: string, e: string, k: number) => Array.from({ length: 751 }, (_, i) => p + "w" + ((i * k) % 97)).join(" ") + e;
    const o = s("", ".", 3) + " " + s("", ".", 5) + " Tail.";
    const r = s("q", "!", 7) + " " + s("r", "!", 11) + " Tail.";
    const t0 = performance.now();
    const d = diffText(o, r);
    expect(performance.now() - t0).toBeLessThan(5000);
    rebuilds(d);
    expect(d.changes.length).toBeGreaterThan(0);
  });

  it("stays exact on large inputs: different sentence counts, repeated phrases, completely different text", () => {
    let seed = 11;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n);
    const vocab = Array.from({ length: 300 }, (_, i) => "w" + i.toString(36));
    const sentence = () => Array.from({ length: 12 }, () => vocab[rnd(vocab.length)]).join(" ") + ". ";
    const many = Array.from({ length: 900 }, sentence);
    // A sentence dropped and every first word changed (different counts, no sentence in common).
    const dropped = many.map((x) => "Q" + x);
    dropped.splice(4, 1);
    // A sentence dropped, the rest unchanged but a few edited (counts differ, most in common).
    const fewer = many.filter((_, i) => i !== 10).map((x, i) => (i % 50 ? x : x.replace(" ", " new ")));
    const other = Array.from({ length: 900 }, sentence);
    for (const [a, b] of [
      [many.join(""), dropped.join("")],
      [many.join(""), fewer.join("")],
      [many.join(""), other.join("")],
      ["a. ".repeat(20_000), "a! ".repeat(20_000)],
      ["In order to learn. ".repeat(5000), "To learn. ".repeat(5000)],
    ]) {
      const d = diffText(a, b);
      rebuilds(d);
      expect(d.changes.length).toBeGreaterThan(0);
      expect(d.changes.every((c) => c.before !== c.after)).toBe(true);
    }
    // Counts differ but most sentences are shared: the edits stay small and the shared text unchanged.
    const d = diffText(many.join(""), fewer.join(""));
    expect(d.changes.length).toBeGreaterThan(10);
    expect(Math.max(...d.changes.map((c) => c.before.length + c.after.length))).toBeLessThan(200);
  }, 60_000);

  it("random edits always rebuild both texts exactly (property check)", () => {
    let seed = 42;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n);
    const pool = ["the", "in order to", "use", ",", ".", " ", "\n", "\r\n", "é", "👍🏽", "日本", "«x»", "'", "\t", "Moreover"];
    for (let i = 0; i < 300; i++) {
      const base = Array.from({ length: rnd(40) }, () => pool[rnd(pool.length)]).join(rnd(2) ? " " : "");
      let other = base;
      for (let e = rnd(6); e > 0; e--) {
        const at = rnd(other.length + 1);
        other = rnd(2) ? other.slice(0, at) + pool[rnd(pool.length)] + other.slice(at) : other.slice(0, at) + other.slice(at + rnd(5));
      }
      const d = diffText(base, other);
      rebuilds(d);
      // Reverting any subset is a valid mix of slices of the two texts.
      const some = new Set(d.changes.filter(() => rnd(2)).map((c) => c.id));
      const mixed = applyReverts(d, some);
      expect(diffText(base, mixed).changes.length).toBeLessThanOrEqual(d.changes.length);
    }
  });
});

describe("applyReverts", () => {
  it("puts back exactly the chosen changes", () => {
    const d = diffText(ROBOTIC, ROBOTIC_HUMANIZED);
    const util = d.changes.find((c) => c.before === "utilize")!;
    const out = applyReverts(d, new Set([util.id]));
    expect(out).toBe(ROBOTIC_HUMANIZED.replace("students use", "students utilize"));
  });
});

describe("explain", () => {
  const r = humanize(ROBOTIC);
  const d = diffText(r.source, r.output);
  const why = (before: string) => explain(d.changes.find((c) => c.before === before)!, r.source, r.edits).reason;

  it("matches each change to the recorded edit that made it", () => {
    expect(why("utilize")).toBe("Simplified an unnecessarily formal expression.");
    expect(why("in order ")).toBe("Simplified an unnecessarily formal expression.");
    expect(why("leverage numerous")).toBe("Simplified an unnecessarily formal expression; Replaced a buzzword with a plain word (SlopMonster vocabulary list).");
    expect(why("In today's fast-paced world, technology")).toBe("Removed a stock opening phrase, and capitalized the next word.");
    expect(why("In conclusion, technology")).toBe("Removed a stock conclusion phrase, and capitalized the next word.");
    expect(why("Furthermore, teachers")).toBe("Removed a repeated transition (an earlier sentence already opens with one), and capitalized the next word.");
    expect(why("Additionally, it is important to note that schools")).toBe(
      "Removed a repeated transition (an earlier sentence already opens with one); Removed a phrase that announces a point instead of making it, and capitalized the next word.",
    );
  });

  it("says 'Wording adjusted for flow' when no recorded edit accounts for the change", () => {
    const c: Change = { id: 0, type: "replaced", before: "crucial", after: "key", origStart: ROBOTIC.indexOf("crucial"), origEnd: ROBOTIC.indexOf("crucial") + 7, revStart: 0, revEnd: 3 };
    expect(explain(c, ROBOTIC, r.edits)).toEqual({ reason: FALLBACK_REASON, rules: [] });
    // A recorded edit elsewhere in the text doesn't explain this spot.
    const far: Change = { ...c, before: "role", origStart: ROBOTIC.indexOf("role"), origEnd: ROBOTIC.indexOf("role") + 4 };
    expect(explain(far, ROBOTIC, [{ rule: "plain-words", before: "utilize", after: "use" }]).reason).toBe(FALLBACK_REASON);
    // An edit whose result doesn't contain the added words doesn't explain it either.
    const u = d.changes.find((x) => x.before === "utilize")!;
    expect(explain({ ...u, after: "employ" }, ROBOTIC, r.edits).reason).toBe(FALLBACK_REASON);
    expect(explain(u, ROBOTIC, []).reason).toBe(FALLBACK_REASON);
  });

  it("names punctuation, spacing and capitalization changes plainly", () => {
    const base = { id: 0, origStart: 0, origEnd: 1, revStart: 0, revEnd: 1 };
    expect(explain({ ...base, type: "punctuation", before: ",", after: ";" }, ",", []).reason).toBe("Punctuation adjusted");
    expect(explain({ ...base, type: "formatting", before: " ", after: "  " }, " ", []).reason).toBe("Spacing or line breaks adjusted");
    expect(explain({ ...base, type: "case", before: "g", after: "G" }, "g", []).reason).toBe("Capitalization adjusted");
  });

  it("an addition is explained only by an edit at that spot", () => {
    const add: Change = { id: 0, type: "added", before: "", after: "many ", origStart: 4, origEnd: 4, revStart: 4, revEnd: 9 };
    expect(explain(add, "The tools", [{ rule: "plain-words", before: "The tools", after: "The many tools" }]).reason).toBe("Simplified an unnecessarily formal expression.");
    expect(explain(add, "The tools", [{ rule: "plain-words", before: "tools", after: "many" }]).reason).toBe("Simplified an unnecessarily formal expression.");
    expect(explain({ ...add, origStart: 0, origEnd: 0 }, "x The tools", [{ rule: "plain-words", before: "tools", after: "many" }]).reason).toBe(FALLBACK_REASON);
  });
});
