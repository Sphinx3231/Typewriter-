/**
 * Playback controller: a small state machine that plays a precomputed
 * timeline into a TypedBuffer.
 *
 * Timing is driven by a monotonic clock and the planned event times, not
 * by chaining fixed delays: every tick applies all events whose planned
 * time has passed, so late timers (background tabs, busy main thread) never
 * add drift. Pause stores the elapsed playback time; resume re-anchors the
 * clock to it, so nothing is lost or replayed.
 */
import { TypedBuffer } from "./buffer";
import { eventIndexAt, type Timeline, type TypingEvent } from "./schedule";

export type PlaybackStatus = "empty" | "ready" | "playing" | "paused" | "completed" | "stopped" | "error";

/** Allowed transitions. Anything else is rejected. */
export const TRANSITIONS: Record<PlaybackStatus, readonly PlaybackStatus[]> = {
  empty: ["ready"],
  ready: ["playing", "empty", "error"],
  playing: ["paused", "completed", "stopped", "error", "playing"],
  paused: ["playing", "stopped", "ready", "empty"],
  completed: ["playing", "ready", "empty"],
  stopped: ["playing", "ready", "empty"],
  error: ["ready", "empty"],
};

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** Coalesces UI notifications; defaults to requestAnimationFrame when available. */
  frame(fn: () => void): void;
}

export const browserClock: Clock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  frame: (fn) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(() => fn()) : setTimeout(fn, 16)),
};

export interface PlaybackSnapshot {
  status: PlaybackStatus;
  elapsedMs: number;
  totalMs: number;
  /** 0..1, from the timeline (elapsed / total), not from character counts. */
  progress: number;
  eventIndex: number;
  eventCount: number;
  /** Source characters correctly in place. */
  sourceDone: number;
  sourceTotal: number;
  /** Words per minute over the last few seconds of playback. */
  currentWpm: number;
  /** Notable recent events, newest first. */
  recent: { at: number; note: string }[];
  error: string | null;
  bufferRevision: number;
  /** Set when the output goes to another application instead of the in-app preview. */
  external?: ExternalInfo;
}

export type ExternalPhase = "idle" | "preparing" | "waiting" | "countdown" | "typing" | "paused" | "resuming" | "completed" | "stopped" | "failed";

export interface ExternalInfo {
  phase: ExternalPhase;
  /** Countdown remaining before the first (or next) keystroke. */
  countdownMs: number;
  /** The window receiving the keys, once chosen. */
  target: { title: string; appName: string } | null;
  /** Why typing paused, stopped or failed (machine-readable). */
  reason: string | null;
  message: string | null;
  /** "sent" means every key went out; only "verified" means the document was checked. */
  verification: "not-run" | "sent" | "verified" | "mismatch";
  verificationDetail: string | null;
  shortcutRegistered: boolean;
}

/** What the UI needs from anything that plays a timeline (preview or another app). */
export interface PlaybackDriver {
  readonly buffer: TypedBuffer;
  subscribe(fn: () => void): () => void;
  getSnapshot(): PlaybackSnapshot;
  onKeystroke(fn: KeystrokeListener): () => void;
  getStatus(): PlaybackStatus;
  getTimeline(): Timeline | null;
  getSource(): string;
  getElapsed(): number;
  load(source: string, timeline: Timeline | null): boolean;
  start(): boolean;
  pause(): boolean;
  resume(): boolean;
  stop(): boolean;
  restart(): boolean;
  reset(): boolean;
  refresh(): void;
  /** Whether restarting is possible (not when the text already went into another app). */
  readonly canRestart: boolean;
}

export type KeystrokeListener = (event: TypingEvent) => void;

const RATE_WINDOW_MS = 5000;
/** Events due within this many ms are applied now; absorbs float rounding in timer arithmetic. */
const DUE_EPSILON_MS = 0.5;

export class PlaybackController implements PlaybackDriver {
  readonly buffer = new TypedBuffer();
  readonly canRestart = true;
  private timeline: Timeline | null = null;
  private source = "";
  private status: PlaybackStatus = "empty";
  private index = 0;
  private anchor = 0; // clock time that corresponds to elapsed = 0
  private frozenElapsed = 0; // elapsed while not playing
  private timer: unknown = null;
  private generation = 0;
  private notifyQueued = false;
  private error: string | null = null;
  private recent: { at: number; note: string }[] = [];
  private listeners = new Set<() => void>();
  private keyListeners = new Set<KeystrokeListener>();
  private snapshot: PlaybackSnapshot;
  /** Number of scheduled tick callbacks currently pending. Exposed for tests (must never exceed 1). */
  pendingTimers = 0;

  constructor(private clock: Clock = browserClock) {
    this.snapshot = this.makeSnapshot();
  }

  // ---- subscriptions (useSyncExternalStore-compatible) ----
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = (): PlaybackSnapshot => this.snapshot;
  onKeystroke(fn: KeystrokeListener): () => void {
    this.keyListeners.add(fn);
    return () => this.keyListeners.delete(fn);
  }

  /** Live elapsed playback time in ms (cheap; for progress readouts between snapshots). */
  getElapsed(): number {
    return Math.min(this.elapsedNow(), this.timeline?.totalMs ?? 0);
  }
  getStatus(): PlaybackStatus {
    return this.status;
  }
  getTimeline(): Timeline | null {
    return this.timeline;
  }
  /** The authoritative source text of the loaded session. */
  getSource(): string {
    return this.source;
  }

  // ---- commands ----

  /** Load a new session. Allowed whenever playback isn't running. */
  load(source: string, timeline: Timeline | null): boolean {
    if (this.status === "playing" || this.status === "paused") return false;
    this.cancelTimer();
    this.source = source;
    this.timeline = timeline;
    this.buffer.reset();
    this.index = 0;
    this.frozenElapsed = 0;
    this.recent = [];
    this.error = null;
    this.status = timeline && timeline.events.length > 0 ? "ready" : "empty";
    this.emit(true);
    return true;
  }

  /** Start from the beginning. From ready, completed or stopped. */
  start(): boolean {
    if (!this.timeline || this.timeline.events.length === 0) return false;
    if (!["ready", "completed", "stopped"].includes(this.status)) return false;
    this.resetPlayback();
    return this.play(0);
  }

  pause(): boolean {
    if (this.status !== "playing") return false;
    this.frozenElapsed = Math.min(this.elapsedNow(), this.timeline?.totalMs ?? 0);
    this.cancelTimer();
    this.setStatus("paused");
    return true;
  }

  resume(): boolean {
    if (this.status !== "paused") return false;
    return this.play(this.frozenElapsed);
  }

  /** Cancel and play again from zero with the same timeline. */
  restart(): boolean {
    if (!this.timeline || this.timeline.events.length === 0) return false;
    if (!["playing", "paused", "completed", "stopped"].includes(this.status)) return false;
    this.cancelTimer();
    this.resetPlayback();
    return this.play(0);
  }

  /** End playback early. The partial output stays visible; it can't be resumed, only restarted. */
  stop(): boolean {
    if (this.status !== "playing" && this.status !== "paused") return false;
    if (this.status === "playing") this.frozenElapsed = Math.min(this.elapsedNow(), this.timeline?.totalMs ?? 0);
    this.cancelTimer();
    this.setStatus("stopped");
    return true;
  }

  /** Leave a finished, stopped or failed session and go back to ready. */
  reset(): boolean {
    if (!["completed", "stopped", "error", "paused"].includes(this.status)) return false;
    this.cancelTimer();
    this.resetPlayback();
    this.setStatus(this.timeline && this.timeline.events.length ? "ready" : "empty");
    return true;
  }

  dispose(): void {
    this.cancelTimer();
    this.listeners.clear();
    this.keyListeners.clear();
  }

  // ---- internals ----

  private canMove(to: PlaybackStatus): boolean {
    return TRANSITIONS[this.status].includes(to);
  }

  private setStatus(to: PlaybackStatus): void {
    if (to !== this.status && !this.canMove(to)) throw new Error(`Invalid playback transition ${this.status} → ${to}`);
    this.status = to;
    this.emit(true);
  }

  private resetPlayback(): void {
    this.buffer.reset();
    this.index = 0;
    this.frozenElapsed = 0;
    this.recent = [];
    this.error = null;
  }

  private play(fromElapsed: number): boolean {
    this.cancelTimer();
    this.anchor = this.clock.now() - fromElapsed;
    this.setStatus("playing");
    this.tick(this.generation);
    return true;
  }

  private elapsedNow(): number {
    return this.status === "playing" ? this.clock.now() - this.anchor : this.frozenElapsed;
  }

  private cancelTimer(): void {
    this.generation++;
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
      this.pendingTimers = Math.max(0, this.pendingTimers - 1);
    }
  }

  private tick(gen: number): void {
    if (gen !== this.generation || this.status !== "playing" || !this.timeline) return;
    const { events } = this.timeline;
    const elapsed = this.elapsedNow();
    let applied = 0;
    while (this.index < events.length && events[this.index].at <= elapsed + DUE_EPSILON_MS) {
      const ev = events[this.index];
      this.buffer.apply(ev, this.index);
      if (ev.note) {
        this.recent.unshift({ at: ev.at, note: ev.note });
        if (this.recent.length > 30) this.recent.length = 30;
      }
      // Only sound keystrokes that are on time, so catching up after a stall doesn't burst audio.
      if (elapsed - ev.at < 120) for (const fn of this.keyListeners) fn(ev);
      this.index++;
      applied++;
    }
    if (this.index >= events.length) {
      this.finish();
      return;
    }
    const wait = Math.max(0, events[this.index].at - this.elapsedNow());
    this.pendingTimers++;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.pendingTimers = Math.max(0, this.pendingTimers - 1);
      this.tick(gen);
    }, wait);
    if (applied > 0) this.emit(false);
  }

  private finish(): void {
    this.cancelTimer();
    this.frozenElapsed = this.timeline?.totalMs ?? 0;
    const output = this.buffer.text();
    if (output !== this.source || this.buffer.hasErrors()) {
      // The same text with a typo cell still marked: point at that cell, not past the end.
      const at = output === this.source ? Math.max(0, this.buffer.errs.indexOf(true)) : firstDifference(output, this.source);
      this.error = `Playback output differs from your text at character ${at + 1}. Your original text is unchanged.`;
      this.setStatus("error");
      return;
    }
    this.setStatus("completed");
  }

  private emit(immediate: boolean): void {
    if (immediate) {
      this.snapshot = this.makeSnapshot();
      for (const fn of this.listeners) fn();
      return;
    }
    if (this.notifyQueued) return;
    this.notifyQueued = true;
    this.clock.frame(() => {
      this.notifyQueued = false;
      this.snapshot = this.makeSnapshot();
      for (const fn of this.listeners) fn();
    });
  }

  /** Refreshes the snapshot's clock-derived fields (elapsed, rate) without a state change. */
  refresh(): void {
    this.emit(true);
  }

  private makeSnapshot(): PlaybackSnapshot {
    const tl = this.timeline;
    const totalMs = tl?.totalMs ?? 0;
    const elapsedMs = Math.min(Math.max(0, this.status === "completed" ? totalMs : this.elapsedNow()), totalMs);
    const lastIdx = this.index - 1;
    const sourceDone = lastIdx >= 0 && tl ? tl.events[lastIdx].src : 0;
    let currentWpm = 0;
    if (tl && elapsedMs > 0 && lastIdx >= 0) {
      const t0 = Math.max(0, elapsedMs - RATE_WINDOW_MS);
      const i0 = eventIndexAt(tl.times, t0);
      const src0 = i0 >= 0 ? tl.events[i0].src : 0;
      const span = elapsedMs - t0;
      if (span > 250) currentWpm = Math.max(0, ((sourceDone - src0) / 5) * (60_000 / span));
    }
    return {
      status: this.status,
      elapsedMs,
      totalMs,
      progress: totalMs > 0 ? elapsedMs / totalMs : 0,
      eventIndex: this.index,
      eventCount: tl?.events.length ?? 0,
      sourceDone,
      sourceTotal: tl ? tl.events[tl.events.length - 1]?.src ?? 0 : 0,
      currentWpm,
      recent: this.recent.slice(0, 8),
      error: this.error,
      bufferRevision: this.buffer.revision,
    };
  }
}

function firstDifference(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return n;
}
