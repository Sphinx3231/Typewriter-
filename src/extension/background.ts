/// <reference types="chrome" />
/**
 * Service worker: opens the side panel from the toolbar button and relays the
 * "Stop typing" keyboard shortcut to the open Typewriter page, and releases the
 * typed-into tab if that page closes mid-session. It never sees the text.
 */
const STOP_MESSAGE = "typewriter:stop";

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

// The Typewriter page reports which tab it has attached the debugger to. If the page goes away
// (side panel closed, window closed) while attached, release the tab here.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "typewriter:session") return;
  let tabId: number | null = null;
  port.onMessage.addListener((msg: { tabId: number | null }) => {
    tabId = msg?.tabId ?? null;
  });
  port.onDisconnect.addListener(() => {
    if (tabId !== null) void chrome.debugger.detach({ tabId }).catch(() => {});
  });
});

export function handleCommand(command: string) {
  if (command === "stop-typing") void chrome.runtime.sendMessage({ type: STOP_MESSAGE }).catch(() => {});
}
chrome.commands.onCommand.addListener(handleCommand);
(self as unknown as { handleCommand: typeof handleCommand }).handleCommand = handleCommand;
