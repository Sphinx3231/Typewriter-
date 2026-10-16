import type { Clock } from "./player";

/** Deterministic clock for tests: time only moves when advance() is called. */
export class FakeClock implements Clock {
  t = 0;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private frames: (() => void)[] = [];
  now = () => this.t;
  setTimeout = (fn: () => void, ms: number) => {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + Math.max(0, ms), fn });
    return id;
  };
  clearTimeout = (h: unknown) => {
    this.timers.delete(h as number);
  };
  frame = (fn: () => void) => {
    this.frames.push(fn);
  };
  get pending() {
    return this.timers.size;
  }
  /** Advance time, firing timers in order. `lag` simulates late timer callbacks. */
  advance(ms: number, lag = 0) {
    const end = this.t + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const e of this.timers) if (!next || e[1].at < next[1].at) next = e;
      if (!next || next[1].at + lag > end) break;
      this.timers.delete(next[0]);
      this.t = Math.max(this.t, next[1].at + lag);
      next[1].fn();
    }
    this.t = end;
    const f = this.frames;
    this.frames = [];
    f.forEach((fn) => fn());
  }
}
