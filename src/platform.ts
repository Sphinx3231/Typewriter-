/** Where Typewriter is running. */
export type Host = "web" | "desktop" | "extension";

export function isDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function isExtension(): boolean {
  const c = (globalThis as { chrome?: { runtime?: { id?: string } } }).chrome;
  return typeof location !== "undefined" && location.protocol === "chrome-extension:" && !!c?.runtime?.id;
}

export function currentHost(): Host {
  return isDesktop() ? "desktop" : isExtension() ? "extension" : "web";
}
