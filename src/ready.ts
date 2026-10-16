import { isDesktop } from "./desktop/bridge";

let done = false;

/**
 * Called once the app has mounted. Shows the desktop window (it starts hidden so
 * there's no flash before the theme is applied) and fades out the launch splash.
 * Uses no animation frames: a hidden webview doesn't deliver them.
 */
export function markReady() {
  if (done) return;
  done = true;
  if (isDesktop()) void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().show()).catch(() => {});
  const boot = document.getElementById("boot");
  if (!boot) return;
  boot.classList.add("is-done");
  setTimeout(() => boot.remove(), 400);
}
