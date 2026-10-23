import { describe, expect, it } from "vitest";
import { AT_THRESHOLD, BELOW_THRESHOLD, NATURAL, ROBOTIC, ROBOTIC_HUMANIZED } from "./fixtures";
import { CHECK_LABELS, humanize, MIN_WORDS, rewrite, runChecks, safetyProblem, score, THRESHOLD, type CheckId, type CheckResult, type Engine } from ".";

const ids = Object.keys(CHECK_LABELS) as CheckId[];
/** Checks with `applicable` of them applicable and the first `flagged` of those flagged. */
function checks(applicable: number, flagged: number): CheckResult[] {
  return ids.map((id, i) => ({ id, label: CHECK_LABELS[id], applicable: i < applicable, flagged: i < flagged, evidence: [] }));
}
const rigged = (applicable: number, flagged: number): Engine => ({ runChecks: () => checks(applicable, flagged), rewrite });

describe("the score", () => {
  it("is flagged applicable checks over applicable checks, as a percentage", () => {
    expect(score(checks(8, 3))).toEqual({ score: 38, flagged: 3, applicable: 8, qualifies: false });
    expect(score(checks(6, 5))).toEqual({ score: 83, flagged: 5, applicable: 6, qualifies: true });
  });

  it("below 50% doesn't qualify", () => {
    expect(score(checks(7, 3)).qualifies).toBe(false); // 42.9%
    expect(score(checks(8, 3)).qualifies).toBe(false); // 37.5%
  });

  it("exactly 50% qualifies", () => {
    expect(score(checks(8, 4))).toMatchObject({ score: 50, qualifies: true });
    expect(score(checks(2, 1))).toMatchObject({ score: 50, qualifies: true });
    expect(THRESHOLD).toBe(50);
  });

  it("above 50% qualifies", () => {
    expect(score(checks(7, 4))).toMatchObject({ score: 57, qualifies: true });
  });

  it("counts only applicable checks: a flag on a check that doesn't apply is ignored", () => {
    const c = checks(4, 2);
    c[6] = { ...c[6], applicable: false, flagged: true };
    expect(score(c)).toMatchObject({ score: 50, flagged: 2, applicable: 4 });
  });

  it("has no score when no check applies", () => {
    expect(score(checks(0, 0))).toEqual({ score: null, flagged: 0, applicable: 0, qualifies: false });
  });
});

describe("humanize: the decision", () => {
  it("the real checklist (not rigged): a text at exactly 50% is rewritten, one flag fewer is not", () => {
    const at = humanize(AT_THRESHOLD, "any");
    expect(at).toMatchObject({ status: "humanized", score: 50, flagged: 5, applicable: 10 });
    expect(at.output).not.toBe(AT_THRESHOLD);
    expect(at.source).toBe(AT_THRESHOLD);
    const below = humanize(BELOW_THRESHOLD, "any");
    expect(below).toMatchObject({ status: "no-change-needed", score: 40, flagged: 4, applicable: 10 });
    expect(below.output).toBe(BELOW_THRESHOLD);
  });

  it("rewrites at exactly 50%", () => {
    const r = humanize(ROBOTIC, "any", rigged(8, 4));
    expect(r).toMatchObject({ status: "humanized", score: 50, flagged: 4, applicable: 8 });
    expect(r.output).toBe(ROBOTIC_HUMANIZED);
  });

  it("rewrites above 50%", () => {
    expect(humanize(ROBOTIC, "any", rigged(8, 7))).toMatchObject({ status: "humanized", score: 88 });
  });

  it("leaves the text unchanged below 50%", () => {
    const r = humanize(ROBOTIC, "any", rigged(8, 3));
    expect(r).toMatchObject({ status: "no-change-needed", score: 38, edits: [] });
    expect(r.output).toBe(ROBOTIC);
  });

  it("leaves the text unchanged, with no score, when no check applies", () => {
    const r = humanize(ROBOTIC, "any", rigged(0, 0));
    expect(r).toMatchObject({ status: "too-short", score: null });
    expect(r.output).toBe(ROBOTIC);
  });

  it("leaves empty and short text unchanged without inventing a score", () => {
    for (const t of ["", "   \n\t", "One sentence only.", "Moreover, in order to utilize this. Furthermore, numerous things."]) {
      const r = humanize(t);
      expect(r).toMatchObject({ status: "too-short", score: null, flagged: 0, applicable: 0 });
      expect(r.output).toBe(t);
      expect(r.checks.every((c) => !c.applicable && !c.flagged)).toBe(true);
    }
    expect(MIN_WORDS).toBe(40);
  });

  it("says so when the checks qualify but no safe small edit exists", () => {
    const r = humanize(NATURAL, "any", rigged(8, 6));
    expect(r).toMatchObject({ status: "no-safe-edit", score: 75 });
    expect(r.output).toBe(NATURAL);
  });
});

describe("humanize: real checks on real text", () => {
  it("a formulaic essay qualifies and gets small edits; facts, numbers, the citation and the quotation stay", () => {
    const r = humanize(ROBOTIC);
    expect(r.status).toBe("humanized");
    expect(r.score!).toBeGreaterThanOrEqual(THRESHOLD);
    expect(r.output).toBe(ROBOTIC_HUMANIZED);
    expect(r.output).toContain("(Smith, 2021)");
    expect(r.output).toContain(`"Moreover, in order to grow, we adapt."`);
    expect(r.output).toContain("30 million");
    expect(r.edits.map((e) => [e.before, e.after])).toEqual([
      ["In today's fast-paced world, technology", "Technology"],
      ["In conclusion, technology", "Technology"],
      ["Furthermore, teachers", "Teachers"],
      ["Additionally, it", "It"],
      ["It is important to note that schools", "Schools"],
      ["in order to", "to"],
      ["in order to", "to"],
      ["utilize", "use"],
      ["commence", "start"],
      ["numerous", "many"],
      ["leverage", "use"],
    ]);
  });

  it("natural writing scores low and is left alone", () => {
    const r = humanize(NATURAL);
    expect(r.status).toBe("no-change-needed");
    expect(r.score).toBeLessThan(THRESHOLD);
    expect(r.output).toBe(NATURAL);
  });

  it("is deterministic and always derived from the source", () => {
    const a = humanize(ROBOTIC);
    const b = humanize(ROBOTIC);
    expect(b).toEqual(a);
    expect(a.source).toBe(ROBOTIC);
  });

  it("each check is labelled and explains itself when flagged", () => {
    const r = runChecks(ROBOTIC);
    expect(r.map((c) => c.id)).toEqual(ids);
    for (const c of r) {
      expect(c.label).toBe(CHECK_LABELS[c.id]);
      if (c.flagged) expect(c.evidence.length).toBeGreaterThan(0);
      else expect(c.evidence).toEqual([]);
    }
    const flagged = r.filter((c) => c.flagged).map((c) => c.id);
    expect(flagged).toEqual(expect.arrayContaining(["formulaic-transitions", "generic-intro-conclusion", "formal-phrasing", "vague-statements"]));
  });

  it("finds redundant sentences and repetitive structure", () => {
    const t =
      "The new library opens on Monday morning downtown. The new library downtown opens Monday morning. The cafe opens at nine every day. The park opens at ten every day. The pool opens at eight every day. The gym opens at six every day. The shop opens at noon every day. The bakery opens at seven every day. The museum opens at eleven every day. The market opens at five every day.";
    const r = runChecks(t);
    expect(r.find((c) => c.id === "redundant-sentences")!.flagged).toBe(true);
    expect(r.find((c) => c.id === "sentence-structure")!.flagged).toBe(true);
    expect(r.find((c) => c.id === "repetitive-wording")!.flagged).toBe(true);
  });

  it("the tone check applies only when a tone is chosen", () => {
    expect(runChecks(ROBOTIC, "any").find((c) => c.id === "tone-mismatch")!.applicable).toBe(false);
    expect(runChecks(ROBOTIC, "casual").find((c) => c.id === "tone-mismatch")).toMatchObject({ applicable: true, flagged: true });
    const chatty = `${NATURAL} It's really cool stuff, and honestly it's a lot of fun. I'm gonna add a third hive next year, okay?`;
    expect(runChecks(chatty, "formal").find((c) => c.id === "tone-mismatch")).toMatchObject({ applicable: true, flagged: true });
    expect(runChecks(NATURAL, "casual").find((c) => c.id === "tone-mismatch")!.flagged).toBe(false);
  });

  it("with a formal tone, formal wording is neither flagged nor simplified", () => {
    const r = runChecks(ROBOTIC, "formal");
    expect(r.find((c) => c.id === "formal-phrasing")!.applicable).toBe(false);
    const out = rewrite(ROBOTIC, "formal").text;
    expect(out).toContain("utilize");
    expect(out).toContain("in order to");
  });
});

describe("the rewrite keeps what it must", () => {
  it("never edits quotations, citations, brackets, links or code", () => {
    const t =
      'Moreover, a. Furthermore, “In order to utilize it” stays. Moreover, he said "in order to win" twice [in order to cite]. See (Lee et al., in order to) and https://example.com/in-order-to and `in order to`. In order to finish, utilize it.';
    const out = rewrite(t).text;
    expect(out).toContain("“In order to utilize it”");
    expect(out).toContain('"in order to win"');
    expect(out).toContain("[in order to cite]");
    expect(out).toContain("(Lee et al., in order to)");
    expect(out).toContain("https://example.com/in-order-to");
    expect(out).toContain("`in order to`");
    expect(out).toContain("To finish, use it.");
    expect(safetyProblem(t, out)).toBeNull();
  });

  it("keeps Unicode, tabs, line breaks and surrounding whitespace", () => {
    const t = `  Café 🎉 naïve 日本語.\tMoreover, x.\r\n\r\nFurthermore, the team will utilize ¡olé! in order to win 3–1.  \n`;
    const out = rewrite(t).text;
    expect(out).toBe(`  Café 🎉 naïve 日本語.\tMoreover, x.\r\n\r\nThe team will use ¡olé! to win 3–1.  \n`);
    expect(safetyProblem(t, out)).toBeNull();
  });

  it("keeps the case of a replaced phrase", () => {
    expect(rewrite("In order to go. Utilizing it. COMMENCED now.").text).toBe("To go. Using it. Started now.");
    expect(rewrite("They utilized and are utilizing it; she utilizes it. It commences.").text).toBe("They used and are using it; she uses it. It starts.");
    expect(rewrite("We delve into it and she delves into that.").text).toBe("We look into it and she looks into that.");
  });

  it("the safety check catches a changed number, quotation, line break or edge whitespace", () => {
    expect(safetyProblem("I have 3 cats.", "I have 4 cats.")).toMatch(/number/);
    expect(safetyProblem('He said "hi".', 'He said "hello".')).toMatch(/quotation/);
    expect(safetyProblem("a\nb", "a b")).toMatch(/line breaks/);
    expect(safetyProblem("a ", "a")).toMatch(/whitespace/);
    expect(safetyProblem("same", "same")).toBeNull();
  });

  it("falls back to the original, saying why, when the safety check fails", () => {
    const bad: Engine = { runChecks: () => checks(4, 4), rewrite: (t) => ({ text: t.replace("30", "31"), edits: [{ rule: "x", before: "30", after: "31" }] }) };
    const r = humanize(ROBOTIC, "any", bad);
    expect(r.status).toBe("failed");
    expect(r.output).toBe(ROBOTIC);
    expect(r.error).toMatch(/number/);
  });

  it("falls back to the original, saying why, when the engine fails", () => {
    const broken: Engine = {
      runChecks: () => {
        throw new Error("checklist crashed");
      },
      rewrite,
    };
    const r = humanize(ROBOTIC, "any", broken);
    expect(r).toMatchObject({ status: "failed", output: ROBOTIC, score: null, error: "checklist crashed" });
  });
});
