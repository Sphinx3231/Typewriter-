/// <reference types="chrome" />
/**
 * The real Browser for a typing session, built on chrome.debugger and chrome.tabs.
 * Attaches to exactly one tab at a time and detaches when the session ends.
 */
import type { KeyAction } from "../engine";
import { commandsFor, PROBE_SCRIPT } from "./cdp";
import type { Browser, BrowserEvent, FocusProbe, TabInfo } from "./session";

export async function ownTabId(): Promise<number | null> {
  try {
    const t = await chrome.tabs.getCurrent();
    return t?.id ?? null;
  } catch {
    return null;
  }
}

/** `onAttachChange` reports the attached tab (or null), so the service worker can release it if this page closes. */
export function chromeBrowser(onAttachChange: (tabId: number | null) => void = () => {}): Browser {
  let tabId: number | null = null;
  let own: number | null | undefined;
  const listeners = new Set<(e: BrowserEvent) => void>();
  const emit = (e: BrowserEvent) => listeners.forEach((fn) => fn(e));

  const onDetach = (src: chrome.debugger.Debuggee, reason: string) => {
    if (src.tabId !== undefined && src.tabId === tabId) {
      tabId = null;
      onAttachChange(null);
      emit({ type: "detached", reason });
    }
  };
  const onEvent = (src: chrome.debugger.Debuggee, method: string, params?: object) => {
    if (src.tabId !== tabId || method !== "Page.frameNavigated") return;
    const frame = (params as { frame?: { parentId?: string } } | undefined)?.frame;
    if (frame && !frame.parentId) emit({ type: "navigated" });
  };
  const onActivated = (info: { tabId: number; windowId: number }) => emit({ type: "tab-activated", tabId: info.tabId, windowId: info.windowId });
  const onRemoved = (id: number) => emit({ type: "tab-removed", tabId: id });

  const send = (method: string, params?: { [key: string]: unknown }) => chrome.debugger.sendCommand({ tabId: tabId! }, method, params);

  return {
    async eligibleActiveTab(): Promise<TabInfo | null> {
      if (own === undefined) own = await ownTabId();
      let win: chrome.windows.Window;
      try {
        win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
      } catch {
        return null;
      }
      const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
      if (!tab?.id || tab.id === own) return null;
      return { id: tab.id, windowId: tab.windowId };
    },
    async attach(id: number) {
      await chrome.debugger.attach({ tabId: id }, "1.3");
      tabId = id;
      onAttachChange(id);
      await send("Page.enable");
      // Lets the page keep its text cursor while you click Typewriter's controls.
      await send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
    },
    async detach() {
      const id = tabId;
      tabId = null;
      onAttachChange(null);
      if (id !== null) await chrome.debugger.detach({ tabId: id }).catch(() => {});
    },
    async probe(): Promise<FocusProbe | null> {
      if (tabId === null) return null;
      try {
        const r = (await send("Runtime.evaluate", { expression: PROBE_SCRIPT, returnByValue: true })) as { result?: { value?: FocusProbe } };
        return r?.result?.value ?? null;
      } catch {
        return null;
      }
    },
    async send(a: KeyAction) {
      for (const c of commandsFor(a)) await send(c.method, c.params);
    },
    onEvent(fn) {
      if (listeners.size === 0) {
        chrome.debugger.onDetach.addListener(onDetach);
        chrome.debugger.onEvent.addListener(onEvent);
        chrome.tabs.onActivated.addListener(onActivated);
        chrome.tabs.onRemoved.addListener(onRemoved);
      }
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
        if (listeners.size === 0) {
          chrome.debugger.onDetach.removeListener(onDetach);
          chrome.debugger.onEvent.removeListener(onEvent);
          chrome.tabs.onActivated.removeListener(onActivated);
          chrome.tabs.onRemoved.removeListener(onRemoved);
        }
      };
    },
  };
}
