/**
 * Output adapter that types into another application.
 *
 * The same timeline the in-app preview plays is handed to the native side,
 * which sends real key events on its own clock. This controller mirrors the
 * native progress into a TypedBuffer, so the Playback panel shows exactly what
 * has been sent, and exposes the same driver interface as the preview.
 *
 * It never reports the destination as matching the original on its own: a
 * finished session is "sent" until the user verifies it (see verify.ts).
 */
import {
  TypedBuffer,
  type ExternalInfo,
  type KeystrokeListener,
  type PlaybackDriver,
  type PlaybackSnapshot,
  type PlaybackStatus,
  type Timeline,
} from "../engine";
import { parseSupportError, type Bridge, type NativeUpdate } from "./bridge";
import { verifyCopiedText, type VerifyResult } from "./verify";

const IDLE: ExternalInfo = {
  phase: "idle",
  countdownMs: 0,
  target: null,
  reason: null,
  message: null,
  verification: "not-run",
  verificationDetail: null,
  shortcutRegistered: true,
};

export interface ExternalOptions {
  countdownMs: number;
  minimize: boolean;
}

export class ExternalController implements PlaybackDriver {
  readonly buffer = new TypedBuffer();
  readonly canRestart = false;
  private timeline: Timeline | null = null;
  private source = "";
  private status: PlaybackStatus = "empty";
  private info: ExternalInfo = IDLE;
  private applied = 0;
  private elapsed = 0;
  private receivedAt = 0;
  private error: string | null = null;
  private recent: { at: number; note: string }[] = [];
  private listeners = new Set<() => void>();
  private keyListeners = new Set<KeystrokeListener>();
  private snapshot: PlaybackSnapshot;
  private options: ExternalOptions = { countdownMs: 5000, minimize: true };
  private session = 0;

  constructor(
    private bridge: Bridge,
    private now: () => number = () => performance.now(),
  ) {
    this.snapshot = this.make();
    bridge.onUpdate((u) => this.onUpdate(u));
  }

  configure(o: Partial<ExternalOptions>) {
    this.options = { ...this.options, ...o };
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.snapshot;
  onKeystroke(fn: KeystrokeListener) {
    this.keyListeners.add(fn);
    return () => this.keyListeners.delete(fn);
  }
  getStatus() {
    return this.status;
  }
  getTimeline() {
    return this.timeline;
  }
  getSource() {
    return this.source;
  }
  getElapsed() {
    const total = this.timeline?.totalMs ?? 0;
    if (this.status === "playing" && this.info.phase === "typing" && this.receivedAt) return Math.min(total, this.elapsed + (this.now() - this.receivedAt));
    return Math.min(total, this.elapsed);
  }

  private running() {
    return this.status === "playing" || this.status === "paused";
  }

  load(source: string, timeline: Timeline | null) {
    if (this.running()) return false;
    this.source = source;
    this.timeline = timeline;
    this.resetMirror();
    this.status = timeline && timeline.events.length ? "ready" : "empty";
    this.info = IDLE;
    this.emit();
    return true;
  }

  /** Arms external typing: nothing is typed until the user leaves Typewriter and the countdown ends. */
  start() {
    if (!this.timeline || !this.timeline.events.length) return false;
    if (!["ready", "completed", "stopped", "error"].includes(this.status)) return false;
    this.resetMirror();
    const session = ++this.session;
    this.status = "playing";
    this.info = { ...IDLE, phase: "waiting", countdownMs: this.options.countdownMs };
    this.emit();
    this.bridge
      .start(this.timeline.events, this.options.countdownMs, this.options.minimize, this.source)
      .then((r) => {
        if (session !== this.session) return;
        this.info = { ...this.info, shortcutRegistered: r.shortcutRegistered };
        this.emit();
      })
      .catch((err) => {
        if (session !== this.session) return;
        const support = parseSupportError(err);
        this.status = "error";
        this.error = support?.message ?? `Couldn't start typing: ${String(err)}`;
        this.info = { ...IDLE, phase: "failed", reason: support?.state ?? "start-failed", message: this.error };
        this.emit();
      });
    return true;
  }

  pause() {
    if (this.status !== "playing" || this.info.phase !== "typing") return false;
    void this.bridge.control("pause").catch(() => {});
    return true;
  }
  resume() {
    if (this.status !== "paused" || this.info.phase !== "paused") return false;
    void this.bridge.control("resume").catch(() => {});
    return true;
  }
  stop() {
    if (!this.running()) return false;
    void this.bridge.control("stop").catch(() => {
      // No native session (it may have just ended): settle locally.
      this.status = "stopped";
      this.info = { ...this.info, phase: "stopped" };
      this.emit();
    });
    return true;
  }
  /** Not offered: the keys already typed are in the other app and would be duplicated. */
  restart() {
    return false;
  }
  reset() {
    if (this.running()) return false;
    this.resetMirror();
    this.status = this.timeline && this.timeline.events.length ? "ready" : "empty";
    this.info = IDLE;
    this.emit();
    return true;
  }
  refresh() {
    this.emit();
  }

  /** Compare text the user copied from the destination with the original. */
  async verifyFromClipboard(): Promise<VerifyResult> {
    let copied = "";
    try {
      copied = await this.bridge.readClipboard();
    } catch {
      copied = "";
    }
    const result = verifyCopiedText(this.source, copied);
    if (result.status !== "empty") {
      this.info = { ...this.info, verification: result.status === "verified" ? "verified" : "mismatch", verificationDetail: result.detail };
      this.emit();
    }
    return result;
  }

  private resetMirror() {
    this.buffer.reset();
    this.applied = 0;
    this.elapsed = 0;
    this.receivedAt = 0;
    this.error = null;
    this.recent = [];
  }

  /** Applies a native status update. Exposed for tests. */
  onUpdate(u: NativeUpdate) {
    if (!this.timeline || !this.running()) return;
    const events = this.timeline.events;
    const upto = Math.min(u.index, events.length);
    while (this.applied < upto) {
      const ev = events[this.applied];
      this.buffer.apply(ev, this.applied);
      if (ev.note) {
        this.recent.unshift({ at: ev.at, note: ev.note });
        if (this.recent.length > 30) this.recent.length = 30;
      }
      if (u.elapsedMs - ev.at < 150) for (const fn of this.keyListeners) fn(ev);
      this.applied++;
    }
    this.elapsed = u.elapsedMs;
    this.receivedAt = this.now();
    const target = u.target ? { title: u.target.title, appName: u.target.appName } : this.info.target;
    this.info = { ...this.info, phase: u.phase, countdownMs: u.countdownMs, target, reason: u.reason, message: u.message };
    switch (u.phase) {
      case "waiting":
      case "countdown":
      case "typing":
        this.status = "playing";
        break;
      case "paused":
      case "resuming":
        this.status = "paused";
        break;
      case "completed":
        if (this.buffer.text() !== this.source) {
          this.status = "error";
          this.error = "The keys sent don't add up to your text. Check the document.";
        } else {
          this.status = "completed";
          const v = u.verification;
          this.info =
            v?.status === "verified"
              ? { ...this.info, verification: "verified", verificationDetail: v.detail }
              : v?.status === "mismatch"
                ? { ...this.info, verification: "mismatch", verificationDetail: v.detail }
                : { ...this.info, verification: "sent", verificationDetail: v?.detail ?? null };
        }
        break;
      case "stopped":
        this.status = "stopped";
        break;
      case "failed":
        this.status = "error";
        this.error = u.message ?? "Typing into the other app failed.";
        break;
    }
    this.emit();
  }

  private emit() {
    this.snapshot = this.make();
    for (const fn of this.listeners) fn();
  }

  private make(): PlaybackSnapshot {
    const totalMs = this.timeline?.totalMs ?? 0;
    const elapsedMs = this.status === "completed" ? totalMs : this.getElapsed();
    const lastIdx = this.applied - 1;
    const events = this.timeline?.events ?? [];
    const sourceDone = lastIdx >= 0 ? events[lastIdx].src : 0;
    let currentWpm = 0;
    if (elapsedMs > 1000 && lastIdx >= 0) {
      // Over the whole session so far; native updates arrive in batches.
      currentWpm = (sourceDone / 5) * (60_000 / elapsedMs);
    }
    return {
      status: this.status,
      elapsedMs,
      totalMs,
      progress: totalMs > 0 ? elapsedMs / totalMs : 0,
      eventIndex: this.applied,
      eventCount: events.length,
      sourceDone,
      sourceTotal: events[events.length - 1]?.src ?? 0,
      currentWpm,
      recent: this.recent.slice(0, 8),
      error: this.error,
      bufferRevision: this.buffer.revision,
      external: this.info,
    };
  }
}
