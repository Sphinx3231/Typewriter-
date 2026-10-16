import type { Step } from "./script";

/**
 * The visible output during playback. Holds graphemes, which ones are
 * temporary mistakes, and the caret. Only `apply` changes it.
 */
export class TypedBuffer {
  cells: string[] = [];
  errs: boolean[] = [];
  caret = 0;
  /** Range of the most recent completed correction, for a brief highlight. */
  lastFix: { start: number; end: number; eventIndex: number } | null = null;
  revision = 0;
  /** Lowest index changed since the renderer last called takeDirty(); Infinity when nothing changed. */
  private dirtyFrom = 0;

  reset(): void {
    this.cells = [];
    this.errs = [];
    this.caret = 0;
    this.lastFix = null;
    this.dirtyFrom = 0;
    this.revision++;
  }

  /** Returns and clears the lowest changed index, so renderers can reuse text that hasn't changed. */
  takeDirty(): number {
    const d = this.dirtyFrom;
    this.dirtyFrom = Infinity;
    return d;
  }

  private touch(i: number) {
    if (i < this.dirtyFrom) this.dirtyFrom = i;
  }

  apply(step: Step, eventIndex = -1): void {
    switch (step.kind) {
      case "type": {
        const g = step.text ?? "";
        this.touch(this.caret);
        if (this.caret === this.cells.length) {
          this.cells.push(g);
          this.errs.push(!!step.err);
        } else {
          this.cells.splice(this.caret, 0, g);
          this.errs.splice(this.caret, 0, !!step.err);
        }
        this.caret++;
        if (step.fix && step.note) this.lastFix = { start: this.caret - 1, end: this.caret, eventIndex };
        break;
      }
      case "backspace": {
        if (this.caret === 0) break;
        this.touch(this.caret - 1);
        if (this.caret === this.cells.length) {
          this.cells.pop();
          this.errs.pop();
        } else {
          this.cells.splice(this.caret - 1, 1);
          this.errs.splice(this.caret - 1, 1);
        }
        this.caret--;
        break;
      }
      case "caret": {
        this.caret = Math.max(0, Math.min(this.cells.length, step.to ?? this.caret));
        break;
      }
      case "replace": {
        const start = step.start ?? 0;
        const end = step.end ?? start;
        const rep = step.replacement ?? [];
        this.touch(start);
        this.cells.splice(start, end - start, ...rep);
        this.errs.splice(start, end - start, ...rep.map(() => false));
        if (this.caret >= end) this.caret += rep.length - (end - start);
        else if (this.caret > start) this.caret = start + rep.length;
        this.lastFix = { start, end: start + rep.length, eventIndex };
        break;
      }
      case "wait":
        break;
    }
    if (step.kind === "caret" && step.note) this.lastFix = { start: this.caret, end: this.caret, eventIndex };
    this.revision++;
  }

  text(): string {
    return this.cells.join("");
  }

  hasErrors(): boolean {
    return this.errs.includes(true);
  }
}
