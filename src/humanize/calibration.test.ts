import { describe, expect, it } from "vitest";
import { HUMAN, STYLED } from "./calibration";
import { humanize, THRESHOLD } from ".";

// What the limits of SlopMonster's checks (index.ts) were chosen against. If a change to the
// checklist breaks one of these, recalibrate and document it; don't just move the numbers.

const scored = (t: string) => humanize(t).checks.filter((c) => c.source === "slopmonster" && !c.advisory && c.flagged).map((c) => c.id);

describe("calibration", () => {
  it("40 public-domain passages (1788–1884): none is rewritten, and SlopMonster's scored checks flag none", () => {
    expect(Object.keys(HUMAN)).toHaveLength(40);
    for (const [name, text] of Object.entries(HUMAN)) {
      const r = humanize(text);
      expect(r.status, name).toBe("no-change-needed");
      expect(r.output, name).toBe(text);
      expect(r.score!, name).toBeLessThanOrEqual(20);
      expect(scored(text), name).toEqual([]);
    }
  });

  it("8 texts in the stock register: SlopMonster's checks flag each at least twice; at the 50% threshold, 2 are rewritten", () => {
    const decisions: Record<string, number> = {};
    for (const [name, text] of Object.entries(STYLED)) {
      expect(scored(text).length, name).toBeGreaterThanOrEqual(2);
      const r = humanize(text);
      decisions[name] = r.score!;
      expect(r.status, name).toBe(r.score! >= THRESHOLD ? "humanized" : "no-change-needed");
    }
    expect(decisions).toEqual({ essay: 60, blog: 40, product: 20, report: 40, email: 40, history: 60, review: 30, cover: 30 });
    expect(THRESHOLD).toBe(50);
  });
});
