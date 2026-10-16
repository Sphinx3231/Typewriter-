/// <reference types="chrome" />
/**
 * Service worker: opens the side panel from the toolbar button and relays the
 * "Stop typing" keyboard shortcut to the open Typewriter page. It never sees the text.
 */
const STOP_MESSAGE = "typewriter:stop";

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

export function handleCommand(command: string) {
  if (command === "stop-typing") void chrome.runtime.sendMessage({ type: STOP_MESSAGE }).catch(() => {});
}
chrome.commands.onCommand.addListener(handleCommand);
(self as unknown as { handleCommand: typeof handleCommand }).handleCommand = handleCommand;
