import { afterEach, describe, expect, it, vi } from "vitest";
import { diffText, explain, applyReverts } from "./diff";
import { NATURAL, ROBOTIC } from "./fixtures";
import { ADVISORY, humanize, rewrite, runChecks, safetyProblem, score, THRESHOLD, type CheckId } from ".";

// SlopMonster's checker inside Typewriter's checklist (index.ts), and the local rules taken from
// its editing guidance.

const PAD = " " + NATURAL; // 63 natural words, so the text is long enough to check
const flagged = (text: string, id: CheckId) => runChecks(text).find((c) => c.id === id)!;

describe("SlopMonster's checks in the checklist", () => {
  it("adds five checks marked as SlopMonster's; two are notes that never count toward the score", () => {
    const checks = runChecks(ROBOTIC);
    expect(checks.filter((c) => c.source === "slopmonster").map((c) => c.id)).toEqual(["buzzwords", "stock-phrases", "rule-of-three", "punctuation-habits", "numeric-claims"]);
    expect([...ADVISORY]).toEqual(["punctuation-habits", "numeric-claims"]);
    expect(checks.filter((c) => c.advisory).map((c) => c.id)).toEqual(["punctuation-habits", "numeric-claims"]);
    // ROBOTIC: Typewriter's 7 applicable checks (tone "any") + 3 scored SlopMonster checks.
    expect(score(checks)).toMatchObject({ applicable: 10 });
    const notes = checks.map((c) => (c.advisory ? { ...c, flagged: true, applicable: true } : c));
    expect(score(notes)).toEqual(score(checks));
  });

  it("don't apply to text too short to judge", () => {
    for (const c of runChecks("A seamless, robust, effortless journey. It's not just a tool, it's a platform.").filter((c) => c.source)) expect(c.applicable).toBe(false);
  });

  it("buzzwords: two or more, not counting words one of Typewriter's own checks already counts", () => {
    expect(flagged("Our seamless tools make the work effortless." + PAD, "buzzwords")).toMatchObject({ flagged: true, evidence: ['"seamless", "effortless"'] });
    expect(flagged("Our seamless tools make the work easy." + PAD, "buzzwords").flagged).toBe(false);
    // "leverage", "delve" (formal phrasing) and "in today's" (generic introduction) are counted there.
    expect(flagged("In today's world we leverage data and delve into it." + PAD, "buzzwords").flagged).toBe(false);
    expect(flagged("Seamless, seamless, seamless." + PAD, "buzzwords").evidence).toEqual(['"seamless" ×3']);
    // Matched by root, as upstream does: elevates, streamlined.
    expect(flagged("It elevates and streamlined everything." + PAD, "buzzwords").flagged).toBe(true);
  });

  it("stock phrases: two or more, contracted or not, curly apostrophes included", () => {
    const t = "It isn’t just a tool, it’s a platform. When it comes to bees, we care." + PAD;
    expect(flagged(t, "stock-phrases")).toMatchObject({ flagged: true, evidence: ["the 'not just X, it's Y' construction; 'when it comes to' filler"] });
    expect(flagged("When it comes to bees, we care." + PAD, "stock-phrases").flagged).toBe(false);
    // "In conclusion" is the generic-conclusion check's.
    expect(flagged("In conclusion, bees. To sum up, honey." + PAD, "stock-phrases").flagged).toBe(false);
  });

  it("lists of three: at least one per 150 words", () => {
    expect(flagged("It was faster, smarter, and better." + PAD, "rule-of-three")).toMatchObject({ flagged: true, evidence: ['"faster, smarter, and better"'] });
    const long = "It was faster, smarter, and better." + PAD + PAD + PAD; // one list in about 195 words
    expect(flagged(long, "rule-of-three").flagged).toBe(false);
    expect(flagged("We shipped red, white, and blue." + PAD, "rule-of-three").flagged).toBe(false);
  });

  it("notes: dash, hyphen and semicolon habits, and numbers next to a claim", () => {
    const p = flagged("Our team — trained and local — is ready." + PAD, "punctuation-habits");
    expect(p).toMatchObject({ flagged: true, advisory: true, evidence: ['two or more em-dashes in one sentence: "Our team — trained and local — is ready."'] });
    expect(flagged("A; b; c; d; e." + PAD, "punctuation-habits").evidence).toEqual(["4 semicolons"]);
    const n = flagged("Loved by 10,000+ happy homeowners and 500 teams, 3 sites, 4 users and 5 clients." + PAD, "numeric-claims");
    expect(n).toMatchObject({ flagged: true, advisory: true });
    expect(n.evidence).toEqual(['"10,000+ happy homeowners", "500 teams", "3 sites", "4 users", and 1 more: make sure each one is real and sourced']);
  });

  it("natural writing stays below the threshold and unchanged", () => {
    const r = humanize(NATURAL);
    expect(r.status).toBe("no-change-needed");
    expect(r.output).toBe(NATURAL);
    expect(r.checks.filter((c) => c.source && c.flagged)).toEqual([]);
  });
});

describe("rules from SlopMonster's editing guidance", () => {
  const edit = (t: string) => rewrite(t).text;

  it("throat-clearing openers go; the sentence stays, capitalized", () => {
    expect(edit("Here's the thing: you need a plan.")).toBe("You need a plan.");
    expect(edit("Plans fail. Here’s the thing: you need a plan.")).toBe("Plans fail. You need a plan.");
    expect(edit("The truth is, nobody reads it.")).toBe("Nobody reads it.");
    expect(edit("The truth is that nobody reads it.")).toBe("Nobody reads it.");
  });

  it("…but not where removing them would change what is said", () => {
    for (const keep of [
      "The truth is simple.",
      "At the end of the day, we went home.",
      "He said here's the thing to buy.",
      "The key is in the drawer.",
      "Where is the remote? Here's the thing. It was under the sofa.",
      "Here's the thing, though: it works.",
      "The box is too big. Let's break it down. Then it fits.",
    ])
      expect(edit(keep)).toBe(keep);
  });

  it("stacked hedges and padding; 'help you to' is only reported", () => {
    expect(edit("It may potentially rain. It could potentially snow. It might possibly clear.")).toBe("It may rain. It could snow. It might clear.");
    expect(edit("A very unique idea, quite literally more than just a plan.")).toBe("A unique idea, literally more than a plan.");
    // "to" can be a preposition here, so no fixed rule may drop it.
    for (const keep of ["It helps you to plan.", "He helps you to your seat."]) expect(edit(keep)).toBe(keep);
    expect(edit("May potentially, Very unique.")).toBe("May, Unique.");
  });

  it("'leverage' as a verb becomes 'use'; the noun stays", () => {
    expect(edit("Teachers leverage the tools. She leveraged existing data. Leveraging AI helps.")).toBe("Teachers use the tools. She used existing data. Using AI helps.");
    for (const keep of ["They gained leverage over rivals.", "The leverage the deal gave them was huge.", "Use financial leverage carefully.", "With more leverage the bank wins."]) expect(edit(keep)).toBe(keep);
    expect(edit("They harness the power of rivers. Harnessing the power of wind works.")).toBe("They use rivers. Using wind works.");
  });

  it("formal tone keeps the buzzword swaps out, like Typewriter's own word swaps", () => {
    expect(rewrite("Teachers leverage the tools.", "formal").text).toBe("Teachers leverage the tools.");
    expect(rewrite("It may potentially rain.", "formal").text).toBe("It may rain.");
  });

  it("never inside quotations, citations, brackets or code", () => {
    const t = `She said "it may potentially rain" (Smith, 2021, may potentially) [may potentially] \`may potentially\`. It may potentially rain.`;
    expect(edit(t)).toBe(`She said "it may potentially rain" (Smith, 2021, may potentially) [may potentially] \`may potentially\`. It may rain.`);
    expect(safetyProblem(t, edit(t))).toBeNull();
  });

  it("every new edit is explained by its own rule in the Studio", () => {
    const src = "Here's the thing: the plan may potentially fail. It is a very unique plan. Teachers leverage the tools." + PAD;
    const r = rewrite(src);
    const d = diffText(src, r.text);
    const reasons = d.changes.map((c) => [c.before, explain(c, src, r.edits).reason]);
    expect(reasons).toEqual([
      ["Here's the thing: the", "Removed a throat-clearing opener that delays the point (SlopMonster), and capitalized the next word."],
      ["potentially ", "Removed a stacked hedge: one qualifier is enough (SlopMonster)."],
      ["very ", "Removed padding around a word that already says it (SlopMonster)."],
      ["leverage", "Replaced a buzzword with a plain word (SlopMonster vocabulary list)."],
    ]);
    // Each change restores on its own, exactly.
    for (let i = 0; i < d.changes.length; i++) {
      const out = applyReverts(d, new Set([i]));
      expect(out).toBe(r.text.slice(0, d.changes[i].revStart) + d.changes[i].before + r.text.slice(d.changes[i].revEnd));
    }
  });
});

describe("the whole step, with SlopMonster's checks", () => {
  const STYLED_ESSAY = `In today's fast-paced world, technology has become a pivotal part of how students learn. It is not just a tool, but a gateway to new opportunities. Moreover, digital platforms empower learners to explore subjects at their own pace, fostering curiosity, independence, and confidence.

Furthermore, teachers can leverage these tools to create engaging lessons. When it comes to collaboration, online spaces allow students to share ideas seamlessly. Additionally, adaptive software can help you to identify gaps in understanding and address them in a holistic way.

In conclusion, technology is a game-changer for education.`;

  it("Unicode, emoji, curly quotes, tabs and Windows line endings: only the edits change; every line break stays", () => {
    const src = STYLED_ESSAY.replaceAll("\n", "\r\n").replace("technology has", "technology 🚀 has").replace("students learn", "élèves\tlearn") + "\r\n";
    const r = humanize(src);
    expect(r.status).toBe("humanized");
    expect(r.score!).toBeGreaterThanOrEqual(THRESHOLD);
    expect(r.output.match(/\r\n/g)!.length).toBe(src.match(/\r\n/g)!.length);
    expect(r.output.match(/\n/g)!.length).toBe(src.match(/\n/g)!.length);
    expect(r.output.startsWith("Technology 🚀 has become")).toBe(true);
    expect(r.output).toContain("élèves\tlearn");
    expect(r.output.endsWith("\r\n")).toBe(true);
    const d = diffText(src, r.output);
    expect(applyReverts(d, new Set())).toBe(r.output);
    expect(applyReverts(d, new Set(d.changes.map((c) => c.id)))).toBe(src);
  });

  it("runs without any network API: fetch, XMLHttpRequest, WebSocket and sendBeacon all throw if touched", () => {
    const boom = () => {
      throw new Error("network used");
    };
    vi.stubGlobal("fetch", boom);
    vi.stubGlobal("XMLHttpRequest", boom);
    vi.stubGlobal("WebSocket", boom);
    vi.stubGlobal("navigator", { sendBeacon: boom });
    const r = humanize(STYLED_ESSAY);
    expect(r.status).toBe("humanized");
    expect(r.error).toBeUndefined();
  });

  afterEach(() => vi.unstubAllGlobals());
});
