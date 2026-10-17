import { describe, expect, it } from "vitest";
import { TypedBuffer } from "./buffer";
import type { Step } from "./script";

const st = (s: Partial<Step> & Pick<Step, "kind">): Step => ({ u: 1, p: 0, ms: 0, fix: false, src: 0, ...s });
const type = (text: string, extra: Partial<Step> = {}) => st({ kind: "type", text, ...extra });

function bufferWith(text: string) {
  const b = new TypedBuffer();
  for (const ch of text) b.apply(type(ch));
  return b;
}

describe("TypedBuffer", () => {
  it("types at the end and inserts in the middle", () => {
    const b = bufferWith("ac");
    b.apply(st({ kind: "caret", to: 1 }));
    b.apply(type("b", { err: true }));
    expect(b.text()).toBe("abc");
    expect(b.errs).toEqual([false, true, false]);
    expect(b.caret).toBe(2);
    expect(b.hasErrors()).toBe(true);
  });

  it("a type step without text inserts an empty cell (output text unchanged)", () => {
    const b = bufferWith("a");
    b.apply(st({ kind: "type" }));
    expect(b.cells).toEqual(["a", ""]);
    expect(b.text()).toBe("a");
    expect(b.caret).toBe(2);
  });

  it("records a completed correction for highlighting only when the fix keystroke has a note", () => {
    const b = new TypedBuffer();
    b.apply(type("x", { fix: true }), 3);
    expect(b.lastFix).toBeNull();
    b.apply(type("y", { fix: true, note: "Corrected" }), 4);
    expect(b.lastFix).toEqual({ start: 1, end: 2, eventIndex: 4 });
  });

  it("backspace at the start does nothing but still bumps the revision", () => {
    const b = new TypedBuffer();
    const rev = b.revision;
    b.apply(st({ kind: "backspace" }));
    expect(b.text()).toBe("");
    expect(b.caret).toBe(0);
    expect(b.revision).toBe(rev + 1);
  });

  it("backspace removes the grapheme before the caret, at the end or in the middle", () => {
    const b = bufferWith("abcd");
    b.apply(st({ kind: "backspace" }));
    expect(b.text()).toBe("abc");
    b.apply(st({ kind: "caret", to: 2 }));
    b.apply(st({ kind: "backspace" }));
    expect(b.text()).toBe("ac");
    expect(b.errs).toHaveLength(2);
    expect(b.caret).toBe(1);
  });

  it("caret moves are clamped to the buffer and a missing target keeps the caret", () => {
    const b = bufferWith("abc");
    b.apply(st({ kind: "caret", to: 99 }));
    expect(b.caret).toBe(3);
    b.apply(st({ kind: "caret", to: -5 }));
    expect(b.caret).toBe(0);
    b.apply(st({ kind: "caret", to: 2 }));
    b.apply(st({ kind: "caret" }));
    expect(b.caret).toBe(2);
  });

  it("a caret move with a note marks the caret position", () => {
    const b = bufferWith("abc");
    b.apply(st({ kind: "caret", to: 1, note: "Moved back" }), 9);
    expect(b.lastFix).toEqual({ start: 1, end: 1, eventIndex: 9 });
  });

  it("replace swaps a range and clears its error flags", () => {
    const b = new TypedBuffer();
    for (const ch of "teh") b.apply(type(ch, { err: true }));
    b.apply(st({ kind: "replace", start: 0, end: 3, replacement: ["t", "h", "e"] }), 7);
    expect(b.text()).toBe("the");
    expect(b.hasErrors()).toBe(false);
    expect(b.lastFix).toEqual({ start: 0, end: 3, eventIndex: 7 });
  });

  it("replace keeps the caret on the same text: after, inside and before the range", () => {
    // caret after the range shifts by the length change
    const after = bufferWith("abcdef");
    after.apply(st({ kind: "replace", start: 1, end: 3, replacement: ["X"] }));
    expect(after.text()).toBe("aXdef");
    expect(after.caret).toBe(5);

    // caret inside the range lands at the end of the replacement
    const inside = bufferWith("abcdef");
    inside.apply(st({ kind: "caret", to: 2 }));
    inside.apply(st({ kind: "replace", start: 1, end: 4, replacement: ["X", "Y"] }));
    expect(inside.text()).toBe("aXYef");
    expect(inside.caret).toBe(3);

    // caret at or before the start stays put
    const before = bufferWith("abcdef");
    before.apply(st({ kind: "caret", to: 1 }));
    before.apply(st({ kind: "replace", start: 1, end: 3, replacement: ["X", "Y", "Z"] }));
    expect(before.text()).toBe("aXYZdef");
    expect(before.caret).toBe(1);
  });

  it("replace with no range or replacement is a no-op edit at 0", () => {
    const b = bufferWith("ab");
    b.apply(st({ kind: "replace" }), 2);
    expect(b.text()).toBe("ab");
    expect(b.caret).toBe(2);
    expect(b.lastFix).toEqual({ start: 0, end: 0, eventIndex: 2 });
  });

  it("replace with only a start removes nothing and inserts the replacement", () => {
    const b = bufferWith("ac");
    b.apply(st({ kind: "replace", start: 1, replacement: ["b"] }));
    expect(b.text()).toBe("abc");
    expect(b.caret).toBe(3);
  });

  it("wait steps change nothing but the revision", () => {
    const b = bufferWith("ab");
    const rev = b.revision;
    b.apply(st({ kind: "wait", u: 0 }));
    expect(b.text()).toBe("ab");
    expect(b.caret).toBe(2);
    expect(b.revision).toBe(rev + 1);
  });

  it("takeDirty reports the lowest changed index once, then nothing", () => {
    const b = new TypedBuffer();
    expect(b.takeDirty()).toBe(0); // a fresh buffer must be rendered in full
    expect(b.takeDirty()).toBe(Infinity);

    for (const ch of "abcd") b.apply(type(ch));
    expect(b.takeDirty()).toBe(0);

    b.apply(type("e"));
    expect(b.takeDirty()).toBe(4);

    b.apply(st({ kind: "caret", to: 1 }));
    expect(b.takeDirty()).toBe(Infinity); // caret moves don't change text
    b.apply(type("X")); // at 1
    b.apply(type("Y")); // at 2: higher index doesn't raise the mark
    expect(b.takeDirty()).toBe(1);

    b.apply(st({ kind: "backspace" })); // removes index 2
    expect(b.takeDirty()).toBe(2);

    b.apply(st({ kind: "replace", start: 3, end: 4, replacement: ["Z"] }));
    expect(b.takeDirty()).toBe(3);

    b.reset();
    expect(b.takeDirty()).toBe(0);
  });

  it("reset clears everything and bumps the revision", () => {
    const b = bufferWith("ab");
    b.apply(st({ kind: "replace", start: 0, end: 1, replacement: ["A"] }));
    const rev = b.revision;
    b.reset();
    expect(b.cells).toEqual([]);
    expect(b.errs).toEqual([]);
    expect(b.caret).toBe(0);
    expect(b.lastFix).toBeNull();
    expect(b.revision).toBe(rev + 1);
    expect(b.hasErrors()).toBe(false);
  });
});
