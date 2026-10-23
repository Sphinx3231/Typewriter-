import { describe, expect, it } from "vitest";
import corpus from "./parity-corpus.json";
import expected from "./parity.json";
import { audit, normalise, PROOF, rootPattern, slopScore, VOCAB, VOCAB_EXACT, type Category, type Hits } from ".";

const groups = (text: string) => new Set((Object.keys(audit(normalise(text))) as Category[]).filter((k) => audit(normalise(text))[k].length > 0));

describe("the port reports exactly what SlopMonster's deslop.py reports", () => {
  it("on every input of the shared corpus (upstream tests, its examples, Typewriter texts, Unicode and edge cases)", () => {
    expect(expected.upstream).toBe("3fc9787d9337b57c599a80afbefbbb3be5a8eb0b");
    expect(expected.cases).toHaveLength(corpus.length);
    const diffs: string[] = [];
    corpus.forEach((text, i) => {
      const got = audit(normalise(text));
      if (JSON.stringify(got) !== JSON.stringify(expected.cases[i])) diffs.push(`#${i} ${JSON.stringify(text.slice(0, 60))}\n  python ${JSON.stringify(expected.cases[i])}\n  port   ${JSON.stringify(got)}`);
    });
    expect(diffs).toEqual([]);
  });

  it("the corpus exercises every category and most rules", () => {
    const seen = new Set<string>();
    for (const c of expected.cases as Hits[]) for (const k of Object.keys(c) as Category[]) for (const h of c[k]) seen.add(`${k}:${Array.isArray(h) ? h[0] : "claim"}`);
    for (const k of ["vocab", "phrases", "punctuation", "rhythm", "proof"]) expect([...seen].some((s) => s.startsWith(k))).toBe(true);
    expect([...seen].filter((s) => s.startsWith("phrases:")).length).toBeGreaterThanOrEqual(14);
    expect([...seen].filter((s) => s.startsWith("vocab:")).length).toBeGreaterThanOrEqual(40);
    expect(seen).toContain("punctuation:semicolon-heavy for web copy");
    expect(seen).toContain("punctuation:two or more em-dashes in one sentence");
  });
});

// Upstream's own regression tests (tools/test_deslop.py), the ones about the rules.
describe("upstream's rule tests, ported", () => {
  it("every catalogue word fires in its base form", () => {
    for (const w of VOCAB) expect(new RegExp(rootPattern(w), "u").test(w.toLowerCase()), w).toBe(true);
    for (const w of VOCAB_EXACT) expect(groups(`We ${w} things.`).has("vocab"), w).toBe(true);
  });

  it("a root too short to stem is matched exactly, as upstream does (python: idle → only 'idle'; elevate → elevates too)", () => {
    const hit = (w: string, t: string) => new RegExp(rootPattern(w), "u").test(t);
    expect([hit("idle", "idle"), hit("idle", "idles"), hit("idle", "idling")]).toEqual([true, false, false]);
    expect([hit("elevate", "elevate"), hit("elevate", "elevates"), hit("elevate", "elevating")]).toEqual([true, true, true]);
  });

  it("inflections fire too", () => {
    for (const w of ["elevates", "unlocks", "empowers", "streamlines", "leverages", "harnessing", "revolutionizes", "innovation", "transformational"])
      expect(groups(`Acme ${w} your workflow.`).has("vocab"), w).toBe(true);
  });

  it("literal senses do not fire", () => {
    for (const ok of ["We craft furniture by hand in Leeds.", "Harness the horse before you load the cart.", "They walked the length of the valley."]) expect(groups(ok).has("vocab"), ok).toBe(false);
  });

  it("constructions, contracted and not", () => {
    for (const bad of [
      "It's not just a tool, it's a platform.",
      "It is not just a tool, it is a platform.",
      "Whether you are a beginner or a pro, start here.",
      "This is where Acme comes in.",
      "Here's the thing. You need a plan.",
      "The result? Teams ship faster.",
      "Ready to get started?",
      "This isn’t just a map, it’s a plan.",
      "It doesn't just score you, it fails the build.",
    ])
      expect(groups(bad).has("phrases"), bad).toBe(true);
    for (const clean of ["Check whether you are on the latest version.", "It's not just about money.", "Do not just take my word for it.", "The lot is not paved, it is grass."])
      expect(groups(clean).has("phrases"), clean).toBe(false);
  });

  it("rule of three: the narrow shapes only", () => {
    expect(groups("Trusted, reliable and built to last.").has("rhythm")).toBe(true);
    expect(groups("It is faster, smarter, and better.").has("rhythm")).toBe(true);
    for (const ok of ["We shipped red, white, and blue.", "On Tuesday, we shipped the release and went home.", "Inspection, repair and replacement for homes and commercial buildings.", "We do not do gutters, siding, windows or conservatories."])
      expect(groups(ok).has("rhythm"), ok).toBe(false);
  });

  it("proof: a number and its noun in one sentence, closed by a word boundary", () => {
    for (const hit of ["10,000+ happy users", "500 teams", "2,000 verified customers", "3.5 million customers"]) expect(new RegExp(PROOF, "iu").test(hit), hit).toBe(true);
    for (const clean of ["\"Don't Make Me Think\", 2000. The reader decides in seconds.", "Roofing, and only roofing, since 2001. Customers come back.", "Version 2.0. Readers can skip it.", "We generated 12 sitemaps last quarter.", "The union sent 300 teamsters."])
      expect(groups(clean).has("proof"), clean).toBe(false);
  });

  it("hyphens: stacking, not the hyphen itself", () => {
    expect(groups("Our industry-leading, context-aware, best-in-class, AI-powered platform ships.").has("punctuation")).toBe(true);
    expect(groups("We fitted a 25-year warranty and a 4.2-hour call-out on a two-storey roof.").has("punctuation")).toBe(false);
  });

  it("typographic characters are folded first, as upstream does", () => {
    expect(normalise("It’s cutting‑edge \r\n\t now ")).toBe("It's cutting-edge now");
    expect(groups("It’s not just a tool, it’s a platform.").has("phrases")).toBe(true);
  });

  it("clean human copy scores 5/5; the score drops one point per failing category", () => {
    for (const ok of ["Six nails per shingle, every shingle.", "You get a written scope and a fixed number before anyone climbs a ladder.", "We do not do overlays. If the roof needs replacing, it gets stripped."])
      expect(slopScore(audit(normalise(ok)))).toBe(5);
    const h = audit(normalise("Loved by 10,000+ happy homeowners. It's not just a roof, it's a seamless journey — truly — trusted, reliable and built to last."));
    expect(slopScore(h)).toBe(0);
    expect(slopScore(h, true)).toBe(1);
  });
});
