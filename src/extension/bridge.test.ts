import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSupportError } from "../desktop/bridge";

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

  it("asks for the debugger permission first, and types nothing when it is refused", async () => {
    const f = fakeChrome(false);
    vi.stubGlobal("chrome", f.chrome);
    vi.stubGlobal("addEventListener", vi.fn());
    const { extensionBridge } = await import("./bridge");
    const bridge = extensionBridge();
    const err = await bridge.start([{ at: 0, kind: "type", text: "a", src: 1 } as never], 2000, false, "a").catch((e) => e);
    const support = parseSupportError(err);
    expect(support?.state).toBe("permission-denied");
    expect(support?.message).toMatch(/Nothing was typed/);
    expect(f.calls).toEqual(["request:debugger"]);
    expect(f.chrome.debugger.attach).not.toHaveBeenCalled();
  });

  it("starts a session once the permission is granted", async () => {
    const f = fakeChrome(true);
    vi.stubGlobal("chrome", f.chrome);
    vi.stubGlobal("addEventListener", vi.fn());
    const { extensionBridge } = await import("./bridge");
    const bridge = extensionBridge();
    const r = await bridge.start([{ at: 0, kind: "type", text: "a", src: 1 } as never], 60_000, false, "a");
    expect(r.shortcutRegistered).toBe(true);
    expect(f.calls[0]).toBe("request:debugger");
    await bridge.control("stop");
  });
});
