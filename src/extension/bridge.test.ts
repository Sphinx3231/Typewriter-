import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSupportError, type NativeUpdate } from "../desktop/bridge";
import type { TypingEvent } from "../engine";

type Listener = (...a: unknown[]) => void;
const ev = () => ({ addListener: vi.fn<(l: Listener) => void>(), removeListener: vi.fn() });

function fakeChrome(granted: boolean) {
  const calls: string[] = [];
  const chrome = {
    permissions: {
      contains: vi.fn(async () => granted),
      request: vi.fn(async (p: { permissions: string[] }) => {
        calls.push(`request:${p.permissions.join(",")}`);
        return granted;
      }),
    },
    commands: { getAll: vi.fn(async () => [{ name: "stop-typing", shortcut: "Alt+Shift+." }]) },
    runtime: { onMessage: ev(), id: "test" },
    debugger: { attach: vi.fn(async () => calls.push("attach")), detach: vi.fn(), sendCommand: vi.fn(), onDetach: ev(), onEvent: ev() },
    tabs: { onActivated: ev(), onRemoved: ev(), getCurrent: vi.fn(async () => undefined), query: vi.fn(async () => [{ id: 3, windowId: 1 }]) },
    windows: { getLastFocused: vi.fn(async () => ({ id: 1 })) },
  };
  return { chrome, calls };
}

describe("extension bridge", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("never prompts at Start (debugger is a required permission), and types nothing if it is missing", async () => {
    const f = fakeChrome(false);
    vi.stubGlobal("chrome", f.chrome);
    vi.stubGlobal("addEventListener", vi.fn());
    const { extensionBridge } = await import("./bridge");
    const bridge = extensionBridge();
    const err = await bridge.start([{ at: 0, kind: "type", text: "a", src: 1 } as never], 2000, false, "a").catch((e) => e);
    const support = parseSupportError(err);
    expect(support?.state).toBe("permission-denied");
    expect(support?.message).toMatch(/Nothing was typed/);
    expect(support?.message).toMatch(/chrome:\/\/extensions/);
    // Chrome rejects permissions.request({permissions: ["debugger"]}): it can't be optional.
    expect(f.chrome.permissions.request).not.toHaveBeenCalled();
    expect(f.chrome.debugger.attach).not.toHaveBeenCalled();
    expect((await bridge.support(false)).available).toBe(false);
  });

  it("starts a session straight away when the permission is present", async () => {
    const f = fakeChrome(true);
    vi.stubGlobal("chrome", f.chrome);
    vi.stubGlobal("addEventListener", vi.fn());
    const { extensionBridge } = await import("./bridge");
    const bridge = extensionBridge();
    expect((await bridge.support(true)).available).toBe(true);
    const updates: { session?: number }[] = [];
    bridge.onUpdate((u) => updates.push(u));
    const r = await bridge.start([{ at: 0, kind: "type", text: "a", src: 1 } as never], 60_000, false, "a", 7);
    expect(r.shortcutRegistered).toBe(true);
    expect(f.chrome.permissions.request).not.toHaveBeenCalled();
    await bridge.control("stop");
    // Every update carries the token given to start, so an earlier session's late updates can be told apart.
    await vi.waitFor(() => expect(updates.length).toBeGreaterThan(0));
    expect(updates.every((u) => u.session === 7)).toBe(true);
  });
});

/* ------------------------------------------------------------------------------------------ */
/* A fuller Chrome fake: events can be fired and a tab with one text field records the keys.   */

type Fn = (...a: never[]) => unknown;
class FakeEvent<F extends Fn> {
  listeners = new Set<F>();
  addListener = vi.fn((l: F) => void this.listeners.add(l));
  removeListener = vi.fn((l: F) => void this.listeners.delete(l));
  fire(...args: Parameters<F>) {
    for (const l of [...this.listeners]) l(...args);
  }
}
class FakePort {
  postMessage = vi.fn((_m: { tabId: number | null }) => {});
  onDisconnect = new FakeEvent<() => void>();
  constructor(public name: string) {}
}

function liveChrome() {
  const ports: FakePort[] = [];
  let typed = "";
  const chrome = {
    permissions: {
      contains: vi.fn(async (_p: object): Promise<boolean> => true),
      request: vi.fn(async (_p: object): Promise<boolean> => true),
    },
    commands: { getAll: vi.fn(async (): Promise<{ name?: string; shortcut?: string }[]> => [{ name: "stop-typing", shortcut: "Alt+Shift+." }]) },
    runtime: {
      onMessage: new FakeEvent<(msg: unknown) => void>(),
      connect: vi.fn((o: { name: string }) => {
        const p = new FakePort(o.name);
        ports.push(p);
        return p;
      }),
    },
    debugger: {
      attach: vi.fn(async (_t: object, _v: string) => {}),
      detach: vi.fn(async (_t: object) => {}),
      sendCommand: vi.fn(async (_t: object, method: string, params?: { type?: string; text?: string }) => {
        if (method === "Input.dispatchKeyEvent" && params?.type === "keyDown" && params.text) typed += params.text;
        if (method === "Runtime.evaluate")
          return { result: { value: { href: "https://example.com/", title: "Example", elementId: "e1", kind: "textarea", editable: true, sensitive: null, text: typed, selStart: typed.length, selEnd: typed.length } } };
        return {};
      }),
      onDetach: new FakeEvent<(src: { tabId?: number }, reason: string) => void>(),
      onEvent: new FakeEvent<(src: { tabId?: number }, method: string, params?: object) => void>(),
    },
    tabs: {
      onActivated: new FakeEvent<(i: object) => void>(),
      onRemoved: new FakeEvent<(id: number) => void>(),
      getCurrent: vi.fn(async () => undefined),
      query: vi.fn(async () => [{ id: 3, windowId: 1 }]),
    },
    windows: { getLastFocused: vi.fn(async () => ({ id: 1 })) },
  };
  return { chrome, ports, typed: () => typed };
}

const keys = (text: string) => [...text].map((ch, i) => ({ at: i * 10, kind: "type", text: ch }) as unknown as TypingEvent);

describe("extension bridge with a live session", () => {
  let f: ReturnType<typeof liveChrome>;
  let pagehide: (() => void) | undefined;
  let updates: NativeUpdate[];

  beforeEach(() => {
    f = liveChrome();
    pagehide = undefined;
    updates = [];
    vi.stubGlobal("chrome", f.chrome);
    vi.stubGlobal(
      "addEventListener",
      vi.fn((type: string, fn: () => void) => {
        if (type === "pagehide") pagehide = fn;
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function load() {
    const mod = await import("./bridge");
    const bridge = mod.extensionBridge();
    bridge.onUpdate((u) => updates.push(u));
    return { ...mod, bridge };
  }
  const ended = (token: number) => updates.find((u) => u.session === token && ["completed", "stopped", "failed"].includes(u.phase));

  it("reads the Stop shortcut Chrome actually assigned", async () => {
    const { stopShortcut } = await load();
    expect(await stopShortcut()).toBe("Alt+Shift+.");
    f.chrome.commands.getAll.mockResolvedValueOnce([{ name: "_execute_action", shortcut: "Ctrl+K" }]);
    expect(await stopShortcut()).toBe("");
    f.chrome.commands.getAll.mockResolvedValueOnce([{ name: "stop-typing" }]);
    expect(await stopShortcut()).toBe("");
    f.chrome.commands.getAll.mockRejectedValueOnce(new Error("commands unavailable"));
    expect(await stopShortcut()).toBe("");
  });

  it("reports the shortcut as not registered when the user removed it", async () => {
    const { bridge } = await load();
    f.chrome.commands.getAll.mockResolvedValue([{ name: "stop-typing", shortcut: "" }]);
    expect(await bridge.start(keys("a"), 60_000, false, "a", 1)).toEqual({ shortcutRegistered: false });
    await bridge.control("stop");
    await vi.waitFor(() => expect(ended(1)?.phase).toBe("stopped"));
  });

  it("treats a failing permission check as no permission", async () => {
    const { hasDebuggerPermission, bridge } = await load();
    f.chrome.permissions.contains.mockRejectedValue(new Error("boom"));
    expect(await hasDebuggerPermission()).toBe(false);
    expect((await bridge.support(false)).state).toBe("permission-denied");
  });

  it("types the text into the active tab, verifies it, detaches, and then has no session", async () => {
    const { bridge } = await load();
    await bridge.start(keys("hi"), 0, false, "hi", 4);
    await vi.waitFor(() => expect(ended(4)).toBeDefined());
    const done = ended(4)!;
    expect(done.phase).toBe("completed");
    expect(done.verification?.status).toBe("verified");
    expect(f.typed()).toBe("hi");
    expect(f.chrome.debugger.attach).toHaveBeenCalledWith({ tabId: 3 }, "1.3");
    expect(f.chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 3 });
    expect(updates.every((u) => u.session === 4)).toBe(true);
    await expect(bridge.control("pause")).rejects.toThrow("No typing session is running.");
  });

  it("tells the service worker which tab is attached, reconnecting if the worker restarts", async () => {
    const { bridge, SESSION_PORT } = await load();
    await bridge.start(keys("abc"), 60_000, false, "abc", 1);
    await vi.waitFor(() => expect(f.ports).toHaveLength(1));
    expect(f.chrome.runtime.connect).toHaveBeenCalledWith({ name: SESSION_PORT });
    await vi.waitFor(() => expect(f.ports[0].postMessage).toHaveBeenCalledWith({ tabId: 3 }));

    f.ports[0].onDisconnect.fire(); // the worker was restarted
    expect(f.ports).toHaveLength(2);
    expect(f.ports[1].postMessage).toHaveBeenCalledWith({ tabId: 3 });

    await bridge.control("stop");
    await vi.waitFor(() => expect(ended(1)?.phase).toBe("stopped"));
    expect(f.ports[1].postMessage).toHaveBeenLastCalledWith({ tabId: null });
    expect(f.chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 3 });
    expect(f.typed()).toBe("");
  });

  it("doesn't reconnect or open a port when nothing is attached any more", async () => {
    const { bridge } = await load();
    await bridge.start(keys("abc"), 60_000, false, "abc", 2);
    await vi.waitFor(() => expect(f.ports[0]?.postMessage).toHaveBeenCalledWith({ tabId: 3 }));
    // Chrome ends the debugging session (the user closed the debugging bar)…
    f.chrome.debugger.onDetach.fire({ tabId: 3 }, "canceled_by_user");
    expect(f.ports[0].postMessage).toHaveBeenLastCalledWith({ tabId: null });
    // …and the worker restarts before the session notices.
    f.ports[0].onDisconnect.fire();
    await vi.waitFor(() => expect(ended(2)).toBeDefined());
    expect(ended(2)).toMatchObject({ phase: "stopped", reason: "detached" });
    expect(f.ports).toHaveLength(1);
    // Chrome had already detached, so Typewriter doesn't detach again.
    expect(f.chrome.debugger.detach).not.toHaveBeenCalled();
  });

  it("stops on the relayed keyboard shortcut and ignores other messages", async () => {
    const { bridge, STOP_MESSAGE } = await load();
    // No session yet: nothing to stop, nothing breaks.
    f.chrome.runtime.onMessage.fire({ type: STOP_MESSAGE });
    f.chrome.runtime.onMessage.fire(undefined);
    await bridge.start(keys("abc"), 60_000, false, "abc", 3);
    await vi.waitFor(() => expect(f.chrome.debugger.attach).toHaveBeenCalled());
    f.chrome.runtime.onMessage.fire({ type: "something-else" });
    f.chrome.runtime.onMessage.fire(null);
    await new Promise((r) => setTimeout(r, 150));
    expect(ended(3)).toBeUndefined();
    f.chrome.runtime.onMessage.fire({ type: STOP_MESSAGE });
    await vi.waitFor(() => expect(ended(3)).toMatchObject({ phase: "stopped", reason: "user" }));
    expect(f.typed()).toBe("");
  });

  it("stops when the panel closes (pagehide)", async () => {
    const { bridge } = await load();
    expect(pagehide).toBeTypeOf("function");
    pagehide!(); // no session: harmless
    await bridge.start(keys("abc"), 60_000, false, "abc", 5);
    await vi.waitFor(() => expect(f.chrome.debugger.attach).toHaveBeenCalled());
    pagehide!();
    await vi.waitFor(() => expect(ended(5)).toMatchObject({ phase: "stopped", reason: "user" }));
    expect(f.chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 3 });
  });

  it("starting again stops the previous session, whose late end doesn't drop the new one", async () => {
    const { bridge } = await load();
    await bridge.start(keys("abc"), 60_000, false, "abc", 1);
    await vi.waitFor(() => expect(f.chrome.debugger.attach).toHaveBeenCalledTimes(1));
    await bridge.start(keys("xyz"), 60_000, false, "xyz", 2);
    await vi.waitFor(() => expect(ended(1)).toMatchObject({ phase: "stopped", reason: "user" }));
    await vi.waitFor(() => expect(f.chrome.debugger.attach).toHaveBeenCalledTimes(2));
    // The second session is still the running one.
    await expect(bridge.control("pause")).resolves.toBeUndefined();
    expect(ended(2)).toBeUndefined();
    await bridge.control("stop");
    await vi.waitFor(() => expect(ended(2)).toMatchObject({ phase: "stopped" }));
    await expect(bridge.control("stop")).rejects.toThrow(/No typing session/);
  });

  it("reads the clipboard only after Chrome grants clipboardRead", async () => {
    const readText = vi.fn(async () => "copied text");
    vi.stubGlobal("navigator", { clipboard: { readText } });
    const { bridge } = await load();
    expect(await bridge.readClipboard()).toBe("copied text");
    expect(f.chrome.permissions.request).toHaveBeenCalledWith({ permissions: ["clipboardRead"] });
    f.chrome.permissions.request.mockResolvedValueOnce(false);
    expect(await bridge.readClipboard()).toBe("");
    f.chrome.permissions.request.mockRejectedValueOnce(new Error("must be called during a user gesture"));
    expect(await bridge.readClipboard()).toBe("");
    expect(readText).toHaveBeenCalledTimes(1);
  });

  it("has nothing to show for showMain, and onUpdate can unsubscribe", async () => {
    const { bridge } = await load();
    await expect(bridge.showMain()).resolves.toBeUndefined();
    const late: NativeUpdate[] = [];
    const off = bridge.onUpdate((u) => late.push(u));
    off();
    await bridge.start(keys("a"), 0, false, "a", 9);
    await vi.waitFor(() => expect(ended(9)).toBeDefined());
    expect(late).toEqual([]);
  });
});
