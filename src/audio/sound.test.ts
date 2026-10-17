// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TypingEvent } from "../engine";
import { TypingSound } from "./sound";

class FakeParam {
  value = 0;
  setTargetAtTime = vi.fn();
  setValueAtTime = vi.fn();
  exponentialRampToValueAtTime = vi.fn();
}
const node = () => ({ connect: vi.fn(<T>(n: T) => n) });

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state: "running" | "suspended" = "running";
  currentTime = 1;
  sampleRate = 1000;
  destination = { kind: "destination" };
  resume = vi.fn(async () => {
    this.state = "running";
  });
  gains: (ReturnType<typeof node> & { gain: FakeParam })[] = [];
  sources: (ReturnType<typeof node> & { buffer: unknown; playbackRate: FakeParam; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> })[] = [];
  filters: (ReturnType<typeof node> & { type: string; frequency: FakeParam; Q: FakeParam })[] = [];
  buffers: { channels: number; length: number; rate: number; data: Float32Array }[] = [];
  constructor() {
    FakeAudioContext.instances.push(this);
  }
  createGain() {
    const g = { ...node(), gain: new FakeParam() };
    this.gains.push(g);
    return g;
  }
  createBuffer(channels: number, length: number, rate: number) {
    const b = { channels, length, rate, data: new Float32Array(length) };
    this.buffers.push(b);
    return { getChannelData: () => b.data };
  }
  createBufferSource() {
    const s = { ...node(), buffer: null as unknown, playbackRate: new FakeParam(), start: vi.fn(), stop: vi.fn() };
    this.sources.push(s);
    return s;
  }
  createBiquadFilter() {
    const f = { ...node(), type: "", frequency: new FakeParam(), Q: new FakeParam() };
    this.filters.push(f);
    return f;
  }
}

type Win = Record<string, unknown>;
const win = window as unknown as Win;
const ev = (kind: TypingEvent["kind"], text?: string): TypingEvent => ({ kind, text, at: 0, u: 1, p: 0, ms: 0, fix: false, src: 0 });

function unlocked() {
  const s = new TypingSound();
  s.unlock();
  const ctx = FakeAudioContext.instances.at(-1)!;
  return { s, ctx, master: ctx.gains[0] };
}

beforeEach(() => {
  FakeAudioContext.instances = [];
  win.AudioContext = FakeAudioContext;
});

afterEach(() => {
  delete win.AudioContext;
  delete win.webkitAudioContext;
  vi.restoreAllMocks();
});

describe("TypingSound unlock", () => {
  it("does nothing when Web Audio is unavailable", () => {
    delete win.AudioContext;
    const s = new TypingSound();
    s.unlock();
    expect(s.isAvailable()).toBe(false);
    s.setEnabled(true);
    s.setVolume(1);
    expect(() => s.play(ev("type", "a"))).not.toThrow();
  });

  it("uses the prefixed webkitAudioContext on older Safari", () => {
    delete win.AudioContext;
    win.webkitAudioContext = FakeAudioContext;
    const s = new TypingSound();
    s.unlock();
    expect(s.isAvailable()).toBe(true);
    expect(FakeAudioContext.instances).toHaveLength(1);
  });

  it("builds a master gain and a 50 ms decaying noise burst", () => {
    const { s, ctx, master } = unlocked();
    expect(s.isAvailable()).toBe(true);
    expect(master.gain.value).toBeCloseTo(0.22 * 0.5 * 0.5); // default volume 0.5, squared curve
    expect(master.connect).toHaveBeenCalledWith(ctx.destination);
    const [buf] = ctx.buffers;
    expect(buf).toMatchObject({ channels: 1, length: 50, rate: 1000 });
    buf.data.forEach((v, i) => expect(Math.abs(v)).toBeLessThanOrEqual(Math.pow(1 - i / 50, 3) + 1e-6));
    expect(buf.data.some((v) => v !== 0)).toBe(true);
  });

  it("a second unlock reuses the context and resumes it only when suspended", () => {
    const { s, ctx } = unlocked();
    s.unlock();
    expect(ctx.resume).not.toHaveBeenCalled();
    ctx.state = "suspended";
    s.unlock();
    expect(ctx.resume).toHaveBeenCalledTimes(1);
    expect(FakeAudioContext.instances).toHaveLength(1);
  });

  it("stays unavailable when creating the context fails", () => {
    win.AudioContext = class {
      constructor() {
        throw new Error("NotAllowedError");
      }
    };
    const s = new TypingSound();
    expect(() => s.unlock()).not.toThrow();
    expect(s.isAvailable()).toBe(false);
  });
});

describe("TypingSound level", () => {
  it("setEnabled fades the master gain in and out", () => {
    const { s, ctx, master } = unlocked();
    s.setEnabled(true);
    expect(master.gain.setTargetAtTime).toHaveBeenLastCalledWith(0.055, ctx.currentTime, 0.01);
    s.setEnabled(false);
    expect(master.gain.setTargetAtTime).toHaveBeenLastCalledWith(0, ctx.currentTime, 0.01);
  });

  it("setEnabled before unlock only records the choice", () => {
    const s = new TypingSound();
    s.setEnabled(true);
    s.unlock();
    const { gains } = FakeAudioContext.instances[0];
    expect(gains[0].gain.setTargetAtTime).not.toHaveBeenCalled();
  });

  it("setVolume clamps to 0..1 and applies only while enabled", () => {
    const { s, master } = unlocked();
    s.setVolume(0.8);
    expect(master.gain.setTargetAtTime).not.toHaveBeenCalled();
    s.setEnabled(true);
    s.setVolume(2);
    expect(master.gain.setTargetAtTime).toHaveBeenLastCalledWith(0.22, expect.any(Number), 0.01);
    s.setVolume(-1);
    expect(master.gain.setTargetAtTime).toHaveBeenLastCalledWith(0, expect.any(Number), 0.01);
    s.setVolume(0.5);
    expect(master.gain.setTargetAtTime.mock.lastCall?.[0]).toBeCloseTo(0.055);
  });
});

describe("TypingSound play", () => {
  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });

  it("is silent while disabled or before unlock", () => {
    const fresh = new TypingSound();
    fresh.setEnabled(true);
    fresh.play(ev("type", "a"));
    const { s, ctx } = unlocked();
    s.play(ev("type", "a"));
    expect(ctx.sources).toHaveLength(0);
  });

  it("plays a short bright click for a letter", () => {
    const { s, ctx, master } = unlocked();
    s.setEnabled(true);
    s.play(ev("type", "a"));
    expect(ctx.sources).toHaveLength(1);
    const [src] = ctx.sources;
    const [filter] = ctx.filters;
    const env = ctx.gains[1];
    expect(src.buffer).not.toBeNull();
    expect(src.playbackRate.value).toBeCloseTo(1.0);
    expect(filter.type).toBe("bandpass");
    expect(filter.frequency.value).toBeCloseTo(2600);
    expect(filter.Q.value).toBe(1.6);
    expect(env.gain.setValueAtTime).toHaveBeenCalledWith(expect.closeTo(0.525, 6), 1);
    expect(env.gain.exponentialRampToValueAtTime).toHaveBeenCalledWith(0.001, expect.closeTo(1.045, 6));
    expect(src.connect).toHaveBeenCalledWith(filter);
    expect(filter.connect).toHaveBeenCalledWith(env);
    expect(env.connect).toHaveBeenCalledWith(master);
    expect(src.start).toHaveBeenCalledWith(1);
    expect(src.stop).toHaveBeenCalledWith(expect.closeTo(1.08, 6));
  });

  it("uses a deeper, louder thunk for space and line breaks", () => {
    const { s, ctx } = unlocked();
    s.setEnabled(true);
    for (const text of [" ", "\n", "\r\n"]) {
      ctx.currentTime += 1;
      s.play(ev("type", text));
    }
    expect(ctx.filters.map((f) => f.frequency.value)).toEqual([900, 900, 900].map((v) => expect.closeTo(v, 6)));
    expect(ctx.filters.every((f) => f.Q.value === 0.9)).toBe(true);
    const env = ctx.gains[1];
    expect(env.gain.setValueAtTime.mock.calls[0][0]).toBeCloseTo(0.9 * 0.875);
    expect(env.gain.exponentialRampToValueAtTime.mock.calls[0][1]).toBeCloseTo(2.07);
  });

  it("uses a mid-pitched click for backspace and replace", () => {
    const { s, ctx } = unlocked();
    s.setEnabled(true);
    s.play(ev("backspace"));
    ctx.currentTime += 1;
    s.play(ev("replace"));
    expect(ctx.filters.map((f) => Math.round(f.frequency.value))).toEqual([1600, 1600]);
  });

  it("ignores waits and caret moves", () => {
    const { s, ctx } = unlocked();
    s.setEnabled(true);
    s.play(ev("wait"));
    s.play(ev("caret"));
    expect(ctx.sources).toHaveLength(0);
  });

  it("plays the very first click even right after the audio clock started", () => {
    const { s, ctx } = unlocked();
    s.setEnabled(true);
    ctx.currentTime = 0.005; // a fresh AudioContext's clock starts at 0
    s.play(ev("type", "a"));
    expect(ctx.sources).toHaveLength(1);
  });

  it("never stacks clicks closer than 18 ms", () => {
    const { s, ctx } = unlocked();
    s.setEnabled(true);
    s.play(ev("type", "a"));
    ctx.currentTime += 0.01;
    s.play(ev("type", "b"));
    expect(ctx.sources).toHaveLength(1);
    ctx.currentTime += 0.01; // 20 ms after the first click
    s.play(ev("type", "c"));
    expect(ctx.sources).toHaveLength(2);
  });
});
