/**
 * Timeline events → key presses (TypeScript twin of src-tauri/native/src/keys.rs).
 *
 * The engine describes typing as edits on a buffer of graphemes. A real text
 * field only understands keys, so this tracks the caret and turns each edit into
 * the keys a person would press. Used by the Chrome extension's output adapter.
 */
import type { TypingEvent } from "./schedule";

export type KeyAction =
  | { kind: "text"; text: string }
  | { kind: "enter" }
  | { kind: "tab" }
  | { kind: "backspace" }
  | { kind: "left" }
  | { kind: "right" };

export function keyFor(grapheme: string): KeyAction {
  if (grapheme === "\n" || grapheme === "\r\n" || grapheme === "\r") return { kind: "enter" };
  if (grapheme === "\t") return { kind: "tab" };
  return { kind: "text", text: grapheme };
}

const repeat = (a: KeyAction, n: number): KeyAction[] => Array.from({ length: Math.max(0, n) }, () => a);

export class Translator {
  caret = 0;
  len = 0;

  actions(ev: Pick<TypingEvent, "kind" | "text" | "to" | "start" | "end" | "replacement">): KeyAction[] {
    switch (ev.kind) {
      case "type":
        this.caret++;
        this.len++;
        return [keyFor(ev.text ?? "")];
      case "backspace":
        if (this.caret === 0) return [];
        this.caret--;
        this.len--;
        return [{ kind: "backspace" }];
      case "caret": {
        const to = Math.min(ev.to ?? this.caret, this.len);
        const out = to < this.caret ? repeat({ kind: "left" }, this.caret - to) : repeat({ kind: "right" }, to - this.caret);
        this.caret = to;
        return out;
      }
      case "replace": {
        const start = Math.min(ev.start ?? 0, this.len);
        const end = Math.min(ev.end ?? start, this.len);
        const rep = ev.replacement ?? [];
        const removed = Math.max(0, end - start);
        const c = this.caret;
        const out: KeyAction[] = c >= end ? repeat({ kind: "left" }, c - end) : repeat({ kind: "right" }, end - c);
        out.push(...repeat({ kind: "backspace" }, removed), ...rep.map(keyFor));
        const after = start + rep.length;
        const target = c >= end ? c - removed + rep.length : c <= start ? c : after;
        out.push(...(target > after ? repeat({ kind: "right" }, target - after) : repeat({ kind: "left" }, after - target)));
        this.caret = target;
        this.len = this.len - removed + rep.length;
        return out;
      }
      default:
        return [];
    }
  }
}

/** A minimal text field that applies key actions; used to prove translations are exact. */
export class VirtualField {
  cells: string[] = [];
  caret = 0;
  apply(a: KeyAction) {
    switch (a.kind) {
      case "text":
        this.cells.splice(this.caret++, 0, a.text);
        break;
      case "enter":
        this.cells.splice(this.caret++, 0, "\n");
        break;
      case "tab":
        this.cells.splice(this.caret++, 0, "\t");
        break;
      case "backspace":
        if (this.caret > 0) this.cells.splice(--this.caret, 1);
        break;
      case "left":
        this.caret = Math.max(0, this.caret - 1);
        break;
      case "right":
        this.caret = Math.min(this.cells.length, this.caret + 1);
        break;
    }
  }
  text() {
    return this.cells.join("");
  }
}
