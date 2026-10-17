import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TypingEvent } from "../engine";
import { isDesktop, parseSupportError, tauriBridge, type NativeUpdate, type Support } from "./bridge";

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

beforeEach(() => {
  invoke.mockReset();
  listen.mockReset();
  invoke.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const update = (phase: NativeUpdate["phase"]): NativeUpdate => ({
  phase,
  index: 3,
  elapsedMs: 100,
  totalMs: 1000,
  countdownMs: 0,
  target: null,
  reason: null,
  message: null,
});

describe("tauriBridge commands", () => {
  it("maps each method to its native command", async () => {
    const support: Support = { available: true, state: "ok", platform: "linux", message: "Ready" };
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "external_support") return support;
      if (cmd === "read_clipboard") return "copied text";
      if (cmd === "external_state") return update("typing");
      return undefined;
    });
    const b = await tauriBridge();
    await expect(b.support(true)).resolves.toBe(support);
    expect(invoke).toHaveBeenLastCalledWith("external_support", { prompt: true });
    await b.control("pause");
    expect(invoke).toHaveBeenLastCalledWith("external_control", { command: "pause" });
    await expect(b.readClipboard()).resolves.toBe("copied text");
    expect(invoke).toHaveBeenLastCalledWith("read_clipboard");
    await b.showMain();
    expect(invoke).toHaveBeenLastCalledWith("show_main");
    await expect(b.state!()).resolves.toMatchObject({ phase: "typing", index: 3 });
    expect(invoke).toHaveBeenLastCalledWith("external_state");
  });

  it("start sends only the fields the native side reads, and the session token", async () => {
    invoke.mockResolvedValue({ shortcutRegistered: true });
    const b = await tauriBridge();
    const events: TypingEvent[] = [
      { kind: "type", text: "a", at: 10, u: 1, p: 0.5, ms: 0, fix: false, src: 1, err: true, note: "Typo" },
      { kind: "replace", start: 0, end: 1, replacement: ["b"], at: 20, u: 1, p: 0, ms: 300, fix: true, src: 1 },
      { kind: "caret", to: 0, at: 30, u: 1, p: 0, ms: 0, fix: true, src: 1 },
    ];
    await expect(b.start(events, 3000, true, "source text", 7)).resolves.toEqual({ shortcutRegistered: true });
    const [cmd, args] = invoke.mock.lastCall!;
    expect(cmd).toBe("external_start");
    expect(args).toEqual({
      events: [
        { kind: "type", at: 10, text: "a", to: undefined, start: undefined, end: undefined, replacement: undefined },
        { kind: "replace", at: 20, text: undefined, to: undefined, start: 0, end: 1, replacement: ["b"] },
        { kind: "caret", at: 30, text: undefined, to: 0, start: undefined, end: undefined, replacement: undefined },
      ],
      countdownMs: 3000,
      minimize: true,
      session: 7,
    });
    // The source text never goes to the native side; it only needs the keystrokes.
    expect(JSON.stringify(args)).not.toContain("source text");
    expect(JSON.stringify(args)).not.toContain("Typo");
  });

  it("start defaults the session token to 0", async () => {
    const b = await tauriBridge();
    await b.start([], 0, false);
    expect(invoke).toHaveBeenLastCalledWith("external_start", { events: [], countdownMs: 0, minimize: false, session: 0 });
  });

  it("propagates native errors", async () => {
    invoke.mockRejectedValue("boom");
    const b = await tauriBridge();
    await expect(b.control("stop")).rejects.toBe("boom");
  });
});

describe("tauriBridge onUpdate", () => {
  it("forwards update payloads and unlistens on unsubscribe", async () => {
    const unlisten = vi.fn();
    let handler: ((e: { payload: NativeUpdate }) => void) | undefined;
    listen.mockImplementation(async (name: string, h: typeof handler) => {
      expect(name).toBe("external://update");
      handler = h;
      return unlisten;
    });
    const b = await tauriBridge();
    const fn = vi.fn();
    const off = b.onUpdate(fn);
    await vi.waitFor(() => expect(handler).toBeDefined());
    await Promise.resolve();
    handler!({ payload: update("countdown") });
    expect(fn).toHaveBeenCalledWith(expect.objectContaining({ phase: "countdown" }));
    expect(unlisten).not.toHaveBeenCalled();
    off();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("unsubscribing before the listener is registered still unlistens once it is", async () => {
    const unlisten = vi.fn();
    let resolve!: (u: () => void) => void;
    listen.mockReturnValue(new Promise<() => void>((r) => (resolve = r)));
    const b = await tauriBridge();
    const off = b.onUpdate(vi.fn());
    off(); // nothing to call yet
    expect(unlisten).not.toHaveBeenCalled();
    resolve(unlisten);
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
    off(); // calling it again is harmless
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});

describe("parseSupportError", () => {
  const support: Support = { available: false, state: "permission-denied", platform: "macos", message: "Allow Accessibility access." };

  it("parses the structured error from a string or an Error", () => {
    expect(parseSupportError(JSON.stringify(support))).toEqual(support);
    expect(parseSupportError(new Error(JSON.stringify(support)))).toEqual(support);
  });

  it("returns null for anything that isn't a support object with a message", () => {
    expect(parseSupportError("typing failed")).toBeNull();
    expect(parseSupportError(JSON.stringify({ available: false }))).toBeNull();
    expect(parseSupportError(JSON.stringify({ message: 5 }))).toBeNull();
    expect(parseSupportError("null")).toBeNull();
    expect(parseSupportError(new Error("not json"))).toBeNull();
    expect(parseSupportError(42)).toBeNull();
    expect(parseSupportError(undefined)).toBeNull();
    expect(parseSupportError({ message: "object, not a string" })).toBeNull();
  });
});

describe("isDesktop (re-exported)", () => {
  it("is true only inside the Tauri webview", () => {
    expect(isDesktop()).toBe(false);
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    expect(isDesktop()).toBe(true);
  });
});
