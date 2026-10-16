/**
 * Subtle typing sounds, synthesized with Web Audio (no audio files, no network).
 * Each keystroke is a short filtered noise burst with a little random pitch and
 * level so repeated keys don't sound mechanical.
 */
import type { TypingEvent } from "../engine";

type Ctx = AudioContext;

export class TypingSound {
  private ctx: Ctx | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private enabled = false;
  private volume = 0.5;
  private lastAt = 0;

  /** Must be called from a user gesture (e.g. the Start click) so the browser allows audio. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    const AC = (window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) as
      | typeof AudioContext
      | undefined;
    if (!AC) return;
    try {
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.gainFor(this.volume);
      this.master.connect(this.ctx.destination);
      const len = Math.floor(this.ctx.sampleRate * 0.05);
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    } catch {
      this.ctx = null;
    }
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on && this.master && this.ctx) this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.01);
    if (on && this.master && this.ctx) this.master.gain.setTargetAtTime(this.gainFor(this.volume), this.ctx.currentTime, 0.01);
  }

  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v));
    if (this.enabled && this.master && this.ctx) this.master.gain.setTargetAtTime(this.gainFor(this.volume), this.ctx.currentTime, 0.01);
  }

  isAvailable(): boolean {
    return !!this.ctx;
  }

  private gainFor(v: number) {
    return 0.22 * v * v;
  }

  play(ev: TypingEvent): void {
    if (!this.enabled || !this.ctx || !this.master || !this.noise) return;
    if (ev.kind === "wait" || ev.kind === "caret") return;
    const now = this.ctx.currentTime;
    if (now - this.lastAt < 0.018) return; // never stack clicks faster than a human could type
    this.lastAt = now;
    const big = ev.kind === "type" && (ev.text === " " || ev.text === "\n" || ev.text === "\r\n");
    const back = ev.kind === "backspace" || ev.kind === "replace";
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.85 + Math.random() * 0.3;
    const filter = this.ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = (big ? 900 : back ? 1600 : 2600) * (0.9 + Math.random() * 0.2);
    filter.Q.value = big ? 0.9 : 1.6;
    const env = this.ctx.createGain();
    const level = (big ? 0.9 : 0.6) * (0.75 + Math.random() * 0.25);
    env.gain.setValueAtTime(level, now);
    env.gain.exponentialRampToValueAtTime(0.001, now + (big ? 0.07 : 0.045));
    src.connect(filter).connect(env).connect(this.master);
    src.start(now);
    src.stop(now + 0.08);
  }
}
