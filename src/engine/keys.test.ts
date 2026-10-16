/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Translator, VirtualField, type KeyAction } from "./keys";
import type { TypingEvent } from "./schedule";

const fixtures = JSON.parse(readFileSync("src-tauri/native/tests/fixtures.json", "utf8")) as { name: string; source: string; events: TypingEvent[] }[];

function run(events: Partial<TypingEvent>[]) {
  const tr = new Translator();
  const f = new VirtualField();
  const all: KeyAction[] = [];
  for (const e of events) {
    for (const a of tr.actions(e as TypingEvent)) {
      f.apply(a);
      all.push(a);
    }
    expect(tr.caret).toBe(f.caret);
    expect(tr.len).toBe(f.cells.length);
  }
  return { f, all };
}
const ty = (text: string) => ({ kind: "type" as const, text, at: 0 });

describe("key translation (TypeScript twin of the native translator)", () => {
  it("line breaks and tabs become keys; text stays literal", () => {
    const { f, all } = run([ty("a"), ty("\n"), ty("\t"), ty("\r\n"), ty("👨‍👩‍👧‍👦"), ty("<script>alert(1)</script>")]);
    expect(all.map((a) => a.kind)).toEqual(["text", "enter", "tab", "enter", "text", "text"]);
    expect(f.text()).toBe("a\n\t\n👨‍👩‍👧‍👦<script>alert(1)</script>");
  });

  it("replace works for every caret position and range", () => {
    for (let caret = 0; caret <= 5; caret++)
      for (const [start, end] of [[0, 0], [1, 3], [0, 5], [2, 2], [4, 5]])
        for (const rep of [[], ["X"], ["X", "Y", "Z"]]) {
          const { f } = run([ty("a"), ty("b"), ty("c"), ty("d"), ty("e"), { kind: "caret", to: caret }, { kind: "replace", start, end, replacement: rep }]);
          const expect_ = "abcde".split("");
          expect_.splice(start, end - start, ...rep);
          expect(f.text()).toBe(expect_.join(""));
        }
  });

  it("reproduces every engine fixture (same set the native tests use)", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(90);
    for (const c of fixtures) expect(run(c.events).f.text(), c.name).toBe(c.source.replace(/\r\n/g, "\n"));
  });
});
