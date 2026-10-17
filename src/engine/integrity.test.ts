/**
 * The text-preservation guarantee, as a test matrix: for every tricky input and
 * every realism setting, (1) the typed buffer ends exactly equal to the source,
 * and (2) the key presses sent to another app reproduce the source exactly in a
 * plain text field. Typos may appear along the way but never survive.
 */
import { describe, expect, it } from "vitest";
import { buildScript, buildTimeline, DEFAULT_SETTINGS, Translator, TypedBuffer, VirtualField, type PlaybackSettings } from "./index";

const CASES: Record<string, string> = {
  punctuation: `Wait... really?! (Yes) [no] {maybe} <tag/> "double" 'single' \`tick\` ; : , . - _ = + * & ^ % $ # @ ! ~ | \\ / ?`,
  "smart punctuation": "“Curly” ‘quotes’ — em dash – en dash … ellipsis · middot • bullet ¶ § © ® ™ € £ ¥ ¢ ° ± × ÷",
  whitespace: "  two leading,   three inside,\ttab,\t\ttwo tabs, trailing   ",
  "non-breaking and odd spaces": "a b c d　e",
  "line breaks": "first\n\nthird after a blank\n\n\nthree blanks\nlast",
  "only newlines": "\n\n\n",
  capitalization: "ALL CAPS, lowercase, MiXeD, iPhone, McDonald's, ÉCOLE, Straße, İstanbul",
  unicode: "Café naïve résumé — 日本語のテキスト, 한국어, العربية, עברית, Ελληνικά, Кириллица",
  emoji: "👍🏽 👨‍👩‍👧‍👦 🇯🇵 🏳️‍🌈 ❤️‍🔥 1️⃣ 🧑🏿‍💻",
  "combining marks": "é ä ñ Z̵̡a̷l̶g̴o",
  "code and markup": "if (a && b) { return x[i] <= 10 ? 'ok' : \"no\"; } // $(rm -rf ~) <script>alert(1)</script> %s {{x}}",
  "user's own typos": "I recieve teh mail evry day; their going tommorow, its definately wierd.",
  "single character": "x",
  "repeated letters": "aaaa bbbb Mississippi bookkeeper",
};

const VARIANTS: Partial<PlaybackSettings>[] = [
  { mistakes: "off" },
  { mistakes: "low", correction: "autocorrect" },
  { mistakes: "medium", correction: "backspace" },
  { mistakes: "medium", correction: "mixed", variation: "high" },
];
const SEEDS = [1, 7, 42, 2026, 99991];

describe("exact text preservation", () => {
  for (const [name, source] of Object.entries(CASES)) {
    it(`${name}: the typed result and the sent keys both equal the source`, () => {
      for (const v of VARIANTS)
        for (const seed of SEEDS) {
          const settings = { ...DEFAULT_SETTINGS, ...v, seed };
          const tl = buildTimeline(buildScript(source, settings), settings);
          const buffer = new TypedBuffer();
          const field = new VirtualField();
          const tr = new Translator();
          tl.events.forEach((ev, i) => {
            buffer.apply(ev, i);
            for (const a of tr.actions(ev)) field.apply(a);
          });
          const label = `${name} ${JSON.stringify(v)} seed ${seed}`;
          expect(buffer.text(), label).toBe(source);
          expect(field.text(), label).toBe(source);
          // Times never go backwards, and the source itself is never modified.
          for (let i = 1; i < tl.events.length; i++) expect(tl.events[i].at).toBeGreaterThanOrEqual(tl.events[i - 1].at);
        }
    });
  }

  it("typos really happen at medium (so the guarantee is tested, not trivially true)", () => {
    const text = Object.values(CASES).join(" ");
    let mistakes = 0;
    let corrections = 0;
    for (const seed of SEEDS) {
      const settings = { ...DEFAULT_SETTINGS, mistakes: "medium" as const, seed };
      const sc = buildScript(text, settings);
      mistakes += sc.mistakes;
      corrections += buildTimeline(sc, settings).events.filter((e) => e.kind === "backspace" || e.kind === "replace").length;
    }
    expect(mistakes).toBeGreaterThan(SEEDS.length);
    expect(corrections).toBeGreaterThan(SEEDS.length);
  });
});
