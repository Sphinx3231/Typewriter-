import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  onMessage = new FakeEvent<(msg: unknown) => void>();
  onDisconnect = new FakeEvent<() => void>();
  constructor(public name: string) {}
}

function fakeChrome() {
  return {
    runtime: {
      onInstalled: new FakeEvent<() => void>(),
      onStartup: new FakeEvent<() => void>(),
      onConnect: new FakeEvent<(p: FakePort) => void>(),
      sendMessage: vi.fn(async (_m: unknown) => {}),
    },
    sidePanel: { setPanelBehavior: vi.fn(async (_o: object) => {}) },
    debugger: { detach: vi.fn(async (_t: { tabId: number }) => {}) },
    commands: { onCommand: new FakeEvent<(c: string) => void>() },
  };
}

let chrome: ReturnType<typeof fakeChrome>;
let worker: { handleCommand?: (c: string) => void };
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  vi.resetModules();
  chrome = fakeChrome();
  worker = {};
  vi.stubGlobal("chrome", chrome);
  vi.stubGlobal("self", worker);
  await import("./background");
});
afterEach(() => vi.unstubAllGlobals());

describe("service worker", () => {
  it("makes the toolbar button open the side panel on install and on browser startup", async () => {
    chrome.runtime.onInstalled.fire();
    expect(chrome.sidePanel.setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: true });
    chrome.runtime.onStartup.fire();
    expect(chrome.sidePanel.setPanelBehavior).toHaveBeenCalledTimes(2);
  });

  it("ignores a failure to set the panel behavior", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    chrome.sidePanel.setPanelBehavior.mockRejectedValue(new Error("sidePanel unavailable"));
    chrome.runtime.onInstalled.fire();
    chrome.runtime.onStartup.fire();
    await flush();
    process.off("unhandledRejection", unhandled);
    expect(chrome.sidePanel.setPanelBehavior).toHaveBeenCalledTimes(2);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("relays the Stop shortcut to the Typewriter page, and nothing else", async () => {
    chrome.commands.onCommand.fire("stop-typing");
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: "typewriter:stop" });
    chrome.commands.onCommand.fire("_execute_action");
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("tolerates no Typewriter page being open to receive the stop", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    chrome.runtime.sendMessage.mockRejectedValue(new Error("Receiving end does not exist."));
    chrome.commands.onCommand.fire("stop-typing");
    await flush();
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("exposes handleCommand on the worker global (used by the extension tests) and it stops typing", async () => {
    const { handleCommand } = await import("./background");
    expect(worker.handleCommand).toBe(handleCommand);
    worker.handleCommand!("stop-typing");
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: "typewriter:stop" });
  });

  it("releases the attached tab when the Typewriter page disconnects mid-session", () => {
    const port = new FakePort("typewriter:session");
    chrome.runtime.onConnect.fire(port);
    port.onMessage.fire({ tabId: 5 });
    port.onDisconnect.fire();
    expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 5 });
  });

  it("tracks the latest reported tab, and releases nothing once the page reports it detached", () => {
    const port = new FakePort("typewriter:session");
    chrome.runtime.onConnect.fire(port);
    port.onMessage.fire({ tabId: 5 });
    port.onMessage.fire({ tabId: 6 });
    port.onMessage.fire({ tabId: null });
    port.onDisconnect.fire();
    expect(chrome.debugger.detach).not.toHaveBeenCalled();

    const port2 = new FakePort("typewriter:session");
    chrome.runtime.onConnect.fire(port2);
    port2.onMessage.fire({ tabId: 6 });
    port2.onMessage.fire(undefined); // malformed message: treated as "nothing attached"
    port2.onDisconnect.fire();
    expect(chrome.debugger.detach).not.toHaveBeenCalled();

    const port3 = new FakePort("typewriter:session");
    chrome.runtime.onConnect.fire(port3);
    port3.onDisconnect.fire(); // never reported a tab
    expect(chrome.debugger.detach).not.toHaveBeenCalled();
  });

  it("keeps each page's session separate and tolerates a tab that's already gone", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    chrome.debugger.detach.mockRejectedValue(new Error("No tab with given id"));
    const a = new FakePort("typewriter:session");
    const b = new FakePort("typewriter:session");
    chrome.runtime.onConnect.fire(a);
    chrome.runtime.onConnect.fire(b);
    a.onMessage.fire({ tabId: 1 });
    b.onMessage.fire({ tabId: 2 });
    b.onDisconnect.fire();
    expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 2 });
    expect(chrome.debugger.detach).toHaveBeenCalledTimes(1);
    await flush();
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("ignores connections from anything other than a Typewriter session", () => {
    const port = new FakePort("something-else");
    chrome.runtime.onConnect.fire(port);
    expect(port.onMessage.addListener).not.toHaveBeenCalled();
    expect(port.onDisconnect.addListener).not.toHaveBeenCalled();
  });
});
