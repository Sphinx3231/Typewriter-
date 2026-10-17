import { describe, expect, it } from "vitest";
import { keyFor, Translator, VirtualField, type KeyAction } from "./keys";
import type { TypingEvent } from "./schedule";

type Ev = Pick<TypingEvent, "kind" | "text" | "to" | "start" | "end" | "replacement">;

function play(events: Ev[]) {
  const tr = new Translator();
  const f = new VirtualField();
  const perEvent: KeyAction[][] = [];
  for (const e of events) {
    const acts = tr.actions(e);
    acts.forEach((a) => f.apply(a));
    perEvent.push(acts);
    expect(tr.caret).toBe(f.caret);
    expect(tr.len).toBe(f.cells.length);
  }
  return { tr, f, perEvent };
}
const ty = (text?: string): Ev => ({ kind: "type", text });

describe("keyFor", () => {
  it("maps every line-break form to Enter and tab to Tab", () => {
    expect(keyFor("\r")).toEqual({ kind: "enter" });
    expect(keyFor("\n")).toEqual({ kind: "enter" });
    expect(keyFor("\r\n")).toEqual({ kind: "enter" });
    expect(keyFor("\t")).toEqual({ kind: "tab" });
    expect(keyFor(" ")).toEqual({ kind: "text", text: " " });
  });
});

describe("Translator edge cases", () => {
  it("a type event without text sends an empty text key", () => {
    const { perEvent, tr } = play([ty()]);
    expect(perEvent[0]).toEqual([{ kind: "text", text: "" }]);
    expect(tr.len).toBe(1);
  });

  it("backspace at the start of the field sends nothing", () => {
    const { perEvent, tr } = play([{ kind: "backspace" }]);
    expect(perEvent[0]).toEqual([]);
    expect(tr.caret).toBe(0);
    expect(tr.len).toBe(0);
  });

  it("caret without a target stays; a target past the end is clamped", () => {
    const { perEvent, f } = play([ty("a"), ty("b"), ty("c"), { kind: "caret" }, { kind: "caret", to: 1 }, { kind: "caret", to: 99 }]);
    expect(perEvent[3]).toEqual([]);
    expect(perEvent[4]).toEqual([{ kind: "left" }, { kind: "left" }]);
    expect(perEvent[5]).toEqual([{ kind: "right" }, { kind: "right" }]);
    expect(f.caret).toBe(3);
  });

  it("replace with missing fields defaults to an empty range at 0", () => {
    const { perEvent, f } = play([ty("a"), { kind: "caret", to: 0 }, { kind: "replace" }]);
    expect(perEvent[2]).toEqual([]);
    expect(f.text()).toBe("a");
    expect(f.caret).toBe(0);
  });

  it("replace without a start replaces from the beginning and restores the caret", () => {
    const { perEvent, f } = play([ty("a"), ty("b"), ty("c"), { kind: "replace", end: 2, replacement: ["X"] }]);
    expect(perEvent[3]).toEqual([{ kind: "left" }, { kind: "backspace" }, { kind: "backspace" }, { kind: "text", text: "X" }, { kind: "right" }]);
    expect(f.text()).toBe("Xc");
    expect(f.caret).toBe(2);
  });

  it("replace without an end inserts at the start", () => {
    const { f } = play([ty("a"), ty("c"), { kind: "replace", start: 1, replacement: ["b"] }]);
    expect(f.text()).toBe("abc");
    expect(f.caret).toBe(3);
  });

  it("replace without a replacement deletes the range", () => {
    const { f } = play([ty("a"), ty("b"), ty("c"), { kind: "caret", to: 0 }, { kind: "replace", start: 1, end: 3 }]);
    expect(f.text()).toBe("a");
    expect(f.caret).toBe(0);
  });

  it("replace with the caret inside the range ends after the replacement", () => {
    const { f, perEvent } = play([ty("a"), ty("b"), ty("c"), ty("d"), { kind: "caret", to: 2 }, { kind: "replace", start: 1, end: 3, replacement: ["X", "Y", "Z"] }]);
    expect(f.text()).toBe("aXYZd");
    expect(f.caret).toBe(4);
    expect(perEvent[5].filter((a) => a.kind === "left" || a.kind === "right")).toEqual([{ kind: "right" }]);
  });

  it("wait events send no keys", () => {
    const { perEvent } = play([ty("a"), { kind: "wait" }]);
    expect(perEvent[1]).toEqual([]);
  });
});

describe("VirtualField", () => {
  it("ignores moves and deletes past its edges", () => {
    const f = new VirtualField();
    f.apply({ kind: "backspace" });
    f.apply({ kind: "left" });
    f.apply({ kind: "right" });
    expect(f.caret).toBe(0);
    expect(f.text()).toBe("");
    f.apply({ kind: "text", text: "a" });
    f.apply({ kind: "enter" });
    f.apply({ kind: "tab" });
    f.apply({ kind: "right" });
    expect(f.caret).toBe(3);
    expect(f.text()).toBe("a\n\t");
  });
});
