import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chromeBrowser, ownTabId } from "./chromeBrowser";
import { commandsFor, PROBE_SCRIPT } from "./cdp";
import type { BrowserEvent, FocusProbe } from "./session";

type Fn = (...a: never[]) => unknown;
/** A chrome.events.Event stand-in that can be fired from the test. */
class FakeEvent<F extends Fn> {
  listeners = new Set<F>();
  addListener = vi.fn((l: F) => void this.listeners.add(l));
  removeListener = vi.fn((l: F) => void this.listeners.delete(l));
  fire(...args: Parameters<F>) {
    for (const l of [...this.listeners]) l(...args);
  }
}

const PROBE: FocusProbe = { href: "https://x.test/", title: "X", elementId: "e1", kind: "textarea", editable: true, sensitive: null, text: "", selStart: 0, selEnd: 0 };

function fakeChrome() {
  const commands: { tabId?: number; method: string; params?: object }[] = [];
  const chrome = {
    tabs: {
      getCurrent: vi.fn(async (): Promise<{ id?: number } | undefined> => ({ id: 1 })),
      query: vi.fn(async (_q: object): Promise<{ id?: number; windowId: number }[]> => [{ id: 5, windowId: 2 }]),
      onActivated: new FakeEvent<(i: { tabId: number; windowId: number }) => void>(),
      onRemoved: new FakeEvent<(id: number) => void>(),
    },
    windows: { getLastFocused: vi.fn(async (_o: object) => ({ id: 2 })) },
    debugger: {
      attach: vi.fn(async (_t: { tabId: number }, _v: string) => {}),
      detach: vi.fn(async (_t: { tabId: number }) => {}),
      sendCommand: vi.fn(async (t: { tabId?: number }, method: string, params?: object): Promise<unknown> => {
        commands.push({ tabId: t.tabId, method, params });
        if (method === "Runtime.evaluate") return { result: { value: PROBE } };
        return {};
      }),
      onDetach: new FakeEvent<(src: { tabId?: number }, reason: string) => void>(),
      onEvent: new FakeEvent<(src: { tabId?: number }, method: string, params?: object) => void>(),
    },
  };
  return { chrome, commands };
}

let f: ReturnType<typeof fakeChrome>;
beforeEach(() => {
  f = fakeChrome();
  vi.stubGlobal("chrome", f.chrome);
});
afterEach(() => vi.unstubAllGlobals());

describe("ownTabId", () => {
  it("is this page's tab id when it runs in a tab", async () => {
    expect(await ownTabId()).toBe(1);
  });
  it("is null in the side panel (no tab) or when Chrome refuses", async () => {
    f.chrome.tabs.getCurrent.mockResolvedValueOnce(undefined);
    expect(await ownTabId()).toBeNull();
    f.chrome.tabs.getCurrent.mockResolvedValueOnce({});
    expect(await ownTabId()).toBeNull();
    f.chrome.tabs.getCurrent.mockRejectedValueOnce(new Error("no"));
    expect(await ownTabId()).toBeNull();
  });
});

describe("chromeBrowser", () => {
  it("offers the active tab of the last focused normal window", async () => {
    const b = chromeBrowser();
    expect(await b.eligibleActiveTab()).toEqual({ id: 5, windowId: 2 });
    expect(f.chrome.windows.getLastFocused).toHaveBeenCalledWith({ windowTypes: ["normal"] });
    expect(f.chrome.tabs.query).toHaveBeenCalledWith({ active: true, windowId: 2 });
    // Its own tab is looked up only once.
    await b.eligibleActiveTab();
    expect(f.chrome.tabs.getCurrent).toHaveBeenCalledTimes(1);
  });

  it("never offers Typewriter's own tab, a tab without an id, or nothing when no window is focused", async () => {
    const b = chromeBrowser();
    f.chrome.tabs.query.mockResolvedValueOnce([{ id: 1, windowId: 2 }]);
    expect(await b.eligibleActiveTab()).toBeNull();
    f.chrome.tabs.query.mockResolvedValueOnce([{ windowId: 2 }]);
    expect(await b.eligibleActiveTab()).toBeNull();
    f.chrome.tabs.query.mockResolvedValueOnce([]);
    expect(await b.eligibleActiveTab()).toBeNull();
    f.chrome.windows.getLastFocused.mockRejectedValueOnce(new Error("No last-focused window"));
    expect(await b.eligibleActiveTab()).toBeNull();
  });

  it("attaches the debugger to one tab, enables page events and focus emulation, and reports it", async () => {
    const reports: (number | null)[] = [];
    const b = chromeBrowser((id) => reports.push(id));
    await b.attach(5);
    expect(f.chrome.debugger.attach).toHaveBeenCalledWith({ tabId: 5 }, "1.3");
    expect(f.commands).toEqual([
      { tabId: 5, method: "Page.enable", params: undefined },
      { tabId: 5, method: "Emulation.setFocusEmulationEnabled", params: { enabled: true } },
    ]);
    expect(reports).toEqual([5]);
  });

  it("still attaches when focus emulation isn't supported", async () => {
    f.chrome.debugger.sendCommand.mockImplementation(async (_t, method) => {
      if (method === "Emulation.setFocusEmulationEnabled") throw new Error("not supported");
      return {};
    });
    const b = chromeBrowser();
    await expect(b.attach(5)).resolves.toBeUndefined();
    await expect(b.probe()).resolves.toEqual(null); // evaluate now returns {} -> no value
  });

  it("fails to attach when Chrome refuses the tab, and stays detached", async () => {
    f.chrome.debugger.attach.mockRejectedValueOnce(new Error("Cannot access a chrome:// URL"));
    const reports: (number | null)[] = [];
    const b = chromeBrowser((id) => reports.push(id));
    await expect(b.attach(5)).rejects.toThrow(/chrome:\/\//);
    expect(reports).toEqual([]);
    expect(await b.probe()).toBeNull();
    expect(f.commands).toEqual([]);
  });

  it("detaches from the attached tab and reports it, tolerating a tab that's already gone", async () => {
    const reports: (number | null)[] = [];
    const b = chromeBrowser((id) => reports.push(id));
    await b.attach(5);
    f.chrome.debugger.detach.mockRejectedValueOnce(new Error("Debugger is not attached"));
    await expect(b.detach()).resolves.toBeUndefined();
    expect(f.chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 5 });
    expect(reports).toEqual([5, null]);
    // Detaching again doesn't touch Chrome.
    await b.detach();
    expect(f.chrome.debugger.detach).toHaveBeenCalledTimes(1);
    expect(reports).toEqual([5, null, null]);
  });

  it("probes the page only with the fixed inspection script, and only while attached", async () => {
    const b = chromeBrowser();
    expect(await b.probe()).toBeNull();
    expect(f.chrome.debugger.sendCommand).not.toHaveBeenCalled();
    await b.attach(5);
    expect(await b.probe()).toEqual(PROBE);
    expect(f.commands.at(-1)).toEqual({ tabId: 5, method: "Runtime.evaluate", params: { expression: PROBE_SCRIPT, returnByValue: true } });
  });

  it("returns null when the probe fails or returns nothing", async () => {
    const b = chromeBrowser();
    await b.attach(5);
    f.chrome.debugger.sendCommand.mockRejectedValueOnce(new Error("Target closed"));
    expect(await b.probe()).toBeNull();
    f.chrome.debugger.sendCommand.mockResolvedValueOnce(undefined);
    expect(await b.probe()).toBeNull();
    f.chrome.debugger.sendCommand.mockResolvedValueOnce({ result: {} });
    expect(await b.probe()).toBeNull();
  });

  it("sends every protocol command of a key action, in order, to the attached tab", async () => {
    const b = chromeBrowser();
    await b.attach(5);
    f.commands.length = 0;
    await b.send({ kind: "text", text: "a" });
    await b.send({ kind: "text", text: "é" });
    await b.send({ kind: "backspace" });
    const expected = [...commandsFor({ kind: "text", text: "a" }), ...commandsFor({ kind: "text", text: "é" }), ...commandsFor({ kind: "backspace" })];
    expect(f.commands).toEqual(expected.map((c) => ({ tabId: 5, ...c })));
  });

  it("propagates a failed key send", async () => {
    const b = chromeBrowser();
    await b.attach(5);
    f.chrome.debugger.sendCommand.mockRejectedValueOnce(new Error("Detached while handling command."));
    await expect(b.send({ kind: "enter" })).rejects.toThrow(/Detached/);
  });

  describe("events", () => {
    it("reports Chrome detaching the attached tab, and ignores other tabs", async () => {
      const reports: (number | null)[] = [];
      const b = chromeBrowser((id) => reports.push(id));
      const got: BrowserEvent[] = [];
      b.onEvent((e) => got.push(e));
      await b.attach(5);
      f.chrome.debugger.onDetach.fire({ tabId: 9 }, "target_closed");
      f.chrome.debugger.onDetach.fire({}, "target_closed");
      expect(got).toEqual([]);
      f.chrome.debugger.onDetach.fire({ tabId: 5 }, "canceled_by_user");
      expect(got).toEqual([{ type: "detached", reason: "canceled_by_user" }]);
      expect(reports).toEqual([5, null]);
      // No longer attached: probing returns null without calling Chrome.
      const before = f.chrome.debugger.sendCommand.mock.calls.length;
      expect(await b.probe()).toBeNull();
      expect(f.chrome.debugger.sendCommand.mock.calls.length).toBe(before);
      // A second detach for the same tab isn't reported again.
      f.chrome.debugger.onDetach.fire({ tabId: 5 }, "target_closed");
      expect(got).toHaveLength(1);
    });

    it("reports a top-level navigation of the attached tab only", async () => {
      const b = chromeBrowser();
      const got: BrowserEvent[] = [];
      b.onEvent((e) => got.push(e));
      await b.attach(5);
      f.chrome.debugger.onEvent.fire({ tabId: 5 }, "Page.frameNavigated", { frame: { id: "sub", parentId: "top" } });
      f.chrome.debugger.onEvent.fire({ tabId: 5 }, "Page.frameNavigated", {});
      f.chrome.debugger.onEvent.fire({ tabId: 5 }, "Page.frameNavigated");
      f.chrome.debugger.onEvent.fire({ tabId: 5 }, "Page.loadEventFired", { frame: { id: "top" } });
      f.chrome.debugger.onEvent.fire({ tabId: 6 }, "Page.frameNavigated", { frame: { id: "top" } });
      expect(got).toEqual([]);
      f.chrome.debugger.onEvent.fire({ tabId: 5 }, "Page.frameNavigated", { frame: { id: "top" } });
      expect(got).toEqual([{ type: "navigated" }]);
    });

    it("relays tab activation and removal", () => {
      const b = chromeBrowser();
      const got: BrowserEvent[] = [];
      b.onEvent((e) => got.push(e));
      f.chrome.tabs.onActivated.fire({ tabId: 8, windowId: 2 });
      f.chrome.tabs.onRemoved.fire(8);
      expect(got).toEqual([
        { type: "tab-activated", tabId: 8, windowId: 2 },
        { type: "tab-removed", tabId: 8 },
      ]);
    });

    it("registers Chrome listeners once for all subscribers and removes them with the last one", () => {
      const b = chromeBrowser();
      const a: BrowserEvent[] = [];
      const c: BrowserEvent[] = [];
      const offA = b.onEvent((e) => a.push(e));
      const offC = b.onEvent((e) => c.push(e));
      for (const ev of [f.chrome.debugger.onDetach, f.chrome.debugger.onEvent, f.chrome.tabs.onActivated, f.chrome.tabs.onRemoved]) {
        expect(ev.addListener).toHaveBeenCalledTimes(1);
        expect(ev.listeners.size).toBe(1);
      }
      f.chrome.tabs.onRemoved.fire(3);
      expect(a).toHaveLength(1);
      expect(c).toHaveLength(1);
      offA();
      f.chrome.tabs.onRemoved.fire(4);
      expect(a).toHaveLength(1);
      expect(c).toHaveLength(2);
      expect(f.chrome.tabs.onRemoved.removeListener).not.toHaveBeenCalled();
      offC();
      for (const ev of [f.chrome.debugger.onDetach, f.chrome.debugger.onEvent, f.chrome.tabs.onActivated, f.chrome.tabs.onRemoved]) {
        expect(ev.removeListener).toHaveBeenCalledTimes(1);
        expect(ev.listeners.size).toBe(0);
      }
      // Subscribing again re-registers.
      b.onEvent(() => {});
      expect(f.chrome.tabs.onRemoved.addListener).toHaveBeenCalledTimes(2);
    });
  });
});
