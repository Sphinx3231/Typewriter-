import { afterEach, describe, expect, it, vi } from "vitest";
import { analyze, CATEGORY_INFO, explain, score, segments, type Analysis } from ".";
import { HUMAN, STYLED } from "./corpus";
import { NATURAL, ROBOTIC } from "./fixtures";
import { handle } from "./protocol";
import { createAnalyzer } from "./service";
import { audit, normalise } from "./slopmonster";

const at = (a: Analysis, rule: string) => a.findings.filter((f) => f.rule === rule);

describe("analyze: SlopMonster's findings, located in the original text", () => {
  it("reports exactly what SlopMonster's checker reports, and never changes the text", () => {
    for (const text of [...Object.values(STYLED), ...Object.values(HUMAN), ROBOTIC, NATURAL]) {
      const a = analyze(text);
      expect(a.source).toBe(text);
      expect(a.hits).toEqual(audit(normalise(text)));
      const n = (k: keyof typeof a.hits) => a.hits[k].reduce((s, h) => s + (Array.isArray(h) && typeof h[1] === "number" ? h[1] : 1), 0);
      expect(a.counts).toEqual({ vocab: n("vocab"), phrases: n("phrases"), punctuation: a.hits.punctuation.length, rhythm: a.hits.rhythm.length, proof: a.hits.proof.length });
      expect(a.findings.map((f) => f.id)).toEqual(a.findings.map((_, i) => i));
      for (let i = 1; i < a.findings.length; i++) expect(a.findings[i].start).toBeGreaterThanOrEqual(a.findings[i - 1].start);
    }
  });

  it("each finding points at the words it is about", () => {
    const a = analyze(STYLED.essay);
    expect(at(a, "pivotal").map((f) => f.excerpt)).toEqual(["pivotal"]);
    expect(at(a, "fast-paced").map((f) => f.excerpt)).toEqual(["fast-paced"]);
    expect(at(a, "in today's").map((f) => f.excerpt)).toEqual(["In today's"]);
    expect(at(a, "the 'not just X, but Y' construction").map((f) => f.excerpt)).toEqual(["not just a tool, but"]);
    expect(at(a, "rule-of-three list").map((f) => f.excerpt)).toEqual(["curiosity, independence, and confidence"]);
    // Root matching, as upstream: "empower" finds "empower", "fostering" is found by "foster".
    expect(at(a, "foster").map((f) => f.excerpt)).toEqual(["fostering"]);
  });

  it("finds the same things through curly apostrophes, non-breaking spaces and hyphens, Windows line breaks, tabs and emoji, and points at the original characters", () => {
    const text = "🚀 It isn’t just a tool,\r\n\tit’s a platform. Our cutting‑edge app serves 10,000+ happy users.\r\n";
    const a = analyze(text);
    expect(a.source).toBe(text);
    expect(at(a, "the 'not just X, it's Y' construction").map((f) => f.excerpt)).toEqual(["n’t just a tool,\r\n\tit"]);
    expect(at(a, "cutting-edge").map((f) => f.excerpt)).toEqual(["cutting‑edge"]);
    expect(at(a, "claim").map((f) => f.excerpt)).toEqual(["10,000+ happy users"]);
    for (const f of a.findings) for (const [s, e] of f.ranges) expect(text.slice(s, e).length).toBe(e - s);
  });

  it("covers the punctuation rules: each dash window, every stacked compound, every semicolon", () => {
    const dashes = analyze("Our team — trained and local — is ready. " + NATURAL);
    expect(at(dashes, "two or more em-dashes in one sentence").map((f) => f.excerpt)).toEqual(["Our team — trained and local — is ready."]);
    const compounds = analyze("Our industry-leading, context-aware, best-in-class, AI-powered platform ships.");
    const c = compounds.findings.find((f) => f.rule.includes("hyphenated compounds"))!;
    expect(c.ranges.map(([s, e]) => compounds.source.slice(s, e))).toEqual(["industry-leading", "context-aware", "best-in-class", "AI-powered"]);
    const semis = analyze("A; b; c; d; e.");
    const s = semis.findings.find((f) => f.rule === "semicolon-heavy for web copy")!;
    expect(s.detail).toBe("4 found");
    expect(s.ranges.map(([x, y]) => semis.source.slice(x, y))).toEqual([";", ";", ";", ";"]);
  });

  it("empty, blank and finding-free text give no findings", () => {
    for (const t of ["", "   ", "\r\n\t", NATURAL]) {
      const a = analyze(t);
      expect(a.findings).toEqual([]);
      expect(score(a)).toBe(5);
    }
  });

  it("explains every finding from SlopMonster's documentation, and names every category", () => {
    const a = analyze(Object.values(STYLED).join("\n\n") + " Loved by 2,000 verified customers; a; b; c; d.");
    const cats = new Set(a.findings.map((f) => f.category));
    expect([...cats].sort()).toEqual(["phrases", "proof", "punctuation", "rhythm", "vocab"]);
    for (const f of a.findings) expect(explain(f).length).toBeGreaterThan(40);
    expect(explain(at(a, "the 'whether you're X or Y' opener")[0] ?? a.findings.find((f) => f.category === "phrases")!)).toMatch(/SlopMonster/);
    for (const k of Object.keys(CATEGORY_INFO)) expect(CATEGORY_INFO[k as keyof typeof CATEGORY_INFO].title).toBeTruthy();
  });

  it("score: SlopMonster's 5 minus one per category with a finding; --allow-proof keeps proof findings but not their penalty", () => {
    const a = analyze("Loved by 10,000+ happy homeowners. It's not just a roof, it's a seamless journey — truly — trusted, reliable and built to last.");
    expect(score(a)).toBe(0);
    expect(score(a, true)).toBe(1);
    expect(a.counts.proof).toBe(1);
  });

  it("runs without any network API: fetch, XMLHttpRequest, WebSocket and sendBeacon all throw if touched", () => {
    const boom = () => {
      throw new Error("network used");
    };
    vi.stubGlobal("fetch", boom);
    vi.stubGlobal("XMLHttpRequest", boom);
    vi.stubGlobal("WebSocket", boom);
    vi.stubGlobal("navigator", { sendBeacon: boom });
    expect(analyze(STYLED.essay).findings.length).toBeGreaterThan(5);
    vi.unstubAllGlobals();
  });
});

describe("segments: the text cut for highlighting", () => {
  it("covers the text once, in order, with every finding's ranges and overlaps", () => {
    const a = analyze(STYLED.essay + "\n\n" + STYLED.blog + " Unlock the power of bees.");
    const segs = segments(a.source.length, a.findings);
    expect(segs[0].start).toBe(0);
    expect(segs[segs.length - 1].end).toBe(a.source.length);
    for (let i = 1; i < segs.length; i++) expect(segs[i].start).toBe(segs[i - 1].end);
    expect(segs.map((s) => a.source.slice(s.start, s.end)).join("")).toBe(a.source);
    for (const f of a.findings)
      for (const [s, e] of f.ranges) {
        const inside = segs.filter((g) => g.start >= s && g.end <= e);
        expect(inside.map((g) => a.source.slice(g.start, g.end)).join("")).toBe(a.source.slice(s, e));
        for (const g of inside) expect(g.ids).toContain(f.id);
      }
    // "Unlock" is inside "Unlock the power": that stretch belongs to both findings.
    const both = segs.find((g) => a.source.slice(g.start, g.end) === "Unlock")!;
    expect(both.ids.map((id) => a.findings[id].rule).sort()).toEqual(["unlock", "unlock the power"]);
  });
});

describe("large documents: no stack overflow, no pathological slowdown", () => {
  const para = (i: number) => `${STYLED.essay.split("\n")[0]} Paragraph ${i} goes on — briefly — and ends.`;
  it("a 500,000-character single paragraph", () => {
    let text = "";
    for (let i = 0; text.length < 500_000; i++) text += para(i) + " ";
    const t0 = performance.now();
    const a = analyze(text);
    const segs = segments(text.length, a.findings);
    const ms = performance.now() - t0;
    expect(a.findings.length).toBeGreaterThan(5000);
    expect(segs.map((s) => text.slice(s.start, s.end)).join("")).toBe(text);
    console.log(`500k single paragraph: ${a.findings.length} findings, ${segs.length} segments, ${Math.round(ms)} ms`);
    expect(ms).toBeLessThan(15_000);
  });

  it("an 800-paragraph document (about 330,000 characters, Windows line breaks)", () => {
    const parts: string[] = [];
    for (let i = 0; i < 800; i++) parts.push(i % 2 ? HUMAN[Object.keys(HUMAN)[i % 40]].slice(0, 500) : para(i));
    const text = parts.join("\r\n\r\n");
    const t0 = performance.now();
    const a = analyze(text);
    const segs = segments(text.length, a.findings);
    const ms = performance.now() - t0;
    expect(a.hits).toEqual(audit(normalise(text)));
    expect(segs.map((s) => text.slice(s.start, s.end)).join("")).toBe(text);
    console.log(`800 paragraphs, ${text.length} chars: ${a.findings.length} findings, ${Math.round(ms)} ms`);
    expect(ms).toBeLessThan(15_000);
  });
});

/** A stand-in for a Web Worker that answers with the real check, when told to. */
class FakeWorker {
  static made: FakeWorker[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  terminated = false;
  inbox: { id: number; text: string }[] = [];
  constructor() {
    FakeWorker.made.push(this);
  }
  postMessage(m: { id: number; text: string }) {
    this.inbox.push(m);
  }
  terminate() {
    this.terminated = true;
  }
  answer() {
    const m = this.inbox.shift()!;
    this.onmessage?.({ data: handle(m) } as MessageEvent);
  }
  crash(message: string) {
    this.onerror?.({ message, preventDefault() {} } as ErrorEvent);
  }
}

describe("the analysis service", () => {
  afterEach(() => {
    vi.useRealTimers();
    FakeWorker.made = [];
  });
  const fake = () => new FakeWorker() as unknown as Worker;

  it("without workers, checks on the main thread after a tick", async () => {
    const svc = createAnalyzer(null);
    const a = await svc.run(STYLED.essay);
    expect(a.source).toBe(STYLED.essay);
    expect(a.findings.length).toBeGreaterThan(5);
  });

  it("a newer check really stops the older one: the busy worker is ended and its answer never used", async () => {
    const svc = createAnalyzer(fake);
    let first: Analysis | null = null;
    void svc.run("first text with a seamless journey").then((a) => (first = a));
    const w1 = FakeWorker.made[0];
    const second = svc.run(STYLED.essay);
    expect(w1.terminated).toBe(true);
    const w2 = FakeWorker.made[1];
    w2.answer();
    expect((await second).source).toBe(STYLED.essay);
    expect(first).toBeNull();
  });

  it("a worker that crashes, or a check that runs too long, fails honestly", async () => {
    const svc = createAnalyzer(fake);
    const p = svc.run("text");
    FakeWorker.made[0].crash("out of memory");
    await expect(p).rejects.toThrow("out of memory");

    vi.useFakeTimers();
    const slow = createAnalyzer(fake, 1000);
    const q = slow.run("text");
    const w = FakeWorker.made[FakeWorker.made.length - 1];
    vi.advanceTimersByTime(1001);
    await expect(q).rejects.toThrow(/took longer than 1 s/);
    expect(w.terminated).toBe(true);
  });

  it("an error inside the checker is reported, not swallowed", () => {
    expect(handle({ id: 1, text: undefined as unknown as string })).toMatchObject({ id: 1, ok: false });
  });
});
