/// <reference types="node" />
/**
 * Exports engine timelines for the native (Rust) tests, so the key translation
 * there is checked against exactly what this engine produces.
 * Regenerate with: npm run fixtures
 */
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildScript } from "./script";
import { buildTimeline } from "./schedule";
import { DEFAULT_SETTINGS, type PlaybackSettings } from "./settings";

const TEXTS = [
  "The quick brown fox jumps over the lazy dog.",
  "I recieve teh mail evry day; their going tommorow!",
  "Line one\nLine two\n\nNew paragraph\twith a tab.",
  "Café naïve — 日本語 👨‍👩‍👧‍👦 🇯🇵 👍🏽 done.",
  "  leading and trailing spaces  ",
  "Typewriters require patience because mechanical keyboards respond slowly. ".repeat(6),
  "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa",
  "Wait... what?! Yes, really; truly: completely. (Parentheses) \"quotes\" 'single'.",
];

export function fixtureCases() {
  const out: { name: string; source: string; events: unknown[] }[] = [];
  const styles: PlaybackSettings["correction"][] = ["autocorrect", "backspace", "mixed"];
  TEXTS.forEach((source, ti) => {
    styles.forEach((correction, si) => {
      for (let seed = 1; seed <= 4; seed++) {
        const s: PlaybackSettings = { ...DEFAULT_SETTINGS, mistakes: "medium", correction, seed: seed * 101 + ti * 7 + si };
        const tl = buildTimeline(buildScript(source, s), { ...s, timingMode: "duration", durationSec: 1 + source.length / 20 });
        out.push({ name: `t${ti}-${correction}-${seed}`, source, events: tl.events.map(({ kind, at, text, to, start, end, replacement }) => ({ kind, at, text, to, start, end, replacement })) });
      }
    });
  });
  return out;
}

describe("native fixtures", () => {
  it("covers every correction style with real typos", () => {
    const cases = fixtureCases();
    const kinds = new Set(cases.flatMap((c) => c.events.map((e) => (e as { kind: string }).kind)));
    expect([...kinds].sort()).toEqual(["backspace", "caret", "replace", "type", "wait"]);
    if (process.env.WRITE_FIXTURES) writeFileSync("src-tauri/native/tests/fixtures.json", JSON.stringify(cases));
  });
});
