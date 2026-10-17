// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTheme } from "./theme";

const { setTheme, getCurrentWindow } = vi.hoisted(() => {
  const setTheme = vi.fn();
  return { setTheme, getCurrentWindow: vi.fn(() => ({ setTheme })) };
});
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow }));

type Win = Record<string, unknown>;
const KEY = "typewriter:theme";

/** A controllable prefers-color-scheme media query. */
function fakeMedia(dark: boolean) {
  const listeners = new Set<() => void>();
  const mql = {
    matches: dark,
    addEventListener: vi.fn((_: string, fn: () => void) => listeners.add(fn)),
    removeEventListener: vi.fn((_: string, fn: () => void) => listeners.delete(fn)),
  };
  const matchMedia = vi.fn(() => mql);
  vi.stubGlobal("matchMedia", matchMedia);
  return {
    mql,
    matchMedia,
    listeners,
    set(next: boolean) {
      mql.matches = next;
      listeners.forEach((fn) => fn());
    },
  };
}

function addMeta() {
  const meta = document.createElement("meta");
  meta.name = "theme-color";
  document.head.appendChild(meta);
  return meta;
}

beforeEach(() => {
  setTheme.mockReset();
  setTheme.mockResolvedValue(undefined);
  getCurrentWindow.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  document.head.innerHTML = "";
  delete document.documentElement.dataset.theme;
  delete (window as unknown as Win).__TAURI_INTERNALS__;
});

describe("useTheme", () => {
  it("follows the light default when matchMedia is unavailable", () => {
    vi.stubGlobal("matchMedia", undefined);
    const meta = addMeta();
    const { result } = renderHook(() => useTheme());
    expect(result.current.preference).toBe("system");
    expect(result.current.theme).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(meta.getAttribute("content")).toBe("#f6f6fb");
  });

  it("follows the OS setting live while the preference is system", () => {
    const media = fakeMedia(true);
    const meta = addMeta();
    const { result, unmount } = renderHook(() => useTheme());
    expect(media.matchMedia).toHaveBeenCalledWith("(prefers-color-scheme: dark)");
    expect(result.current.theme).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(meta.getAttribute("content")).toBe("#0a0a0d");

    act(() => media.set(false));
    expect(result.current.theme).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");

    unmount();
    expect(media.listeners.size).toBe(0);
    expect(media.mql.removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
  });

  it("an explicit saved choice wins over the OS setting", () => {
    localStorage.setItem(KEY, "light");
    const media = fakeMedia(true);
    const { result } = renderHook(() => useTheme());
    expect(result.current.preference).toBe("light");
    expect(result.current.theme).toBe("light");
    act(() => media.set(false));
    act(() => media.set(true));
    expect(result.current.theme).toBe("light");
  });

  it("ignores an unknown saved value", () => {
    localStorage.setItem(KEY, "sepia");
    fakeMedia(false);
    const { result } = renderHook(() => useTheme());
    expect(result.current.preference).toBe("system");
    expect(result.current.theme).toBe("light");
  });

  it("setPreference saves explicit choices and clears the key for system", () => {
    fakeMedia(false);
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setPreference("dark"));
    expect(result.current.theme).toBe("dark");
    expect(localStorage.getItem(KEY)).toBe("dark");
    act(() => result.current.setPreference("system"));
    expect(result.current.preference).toBe("system");
    expect(result.current.theme).toBe("light");
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("toggle flips the effective theme and saves it", () => {
    fakeMedia(true); // system dark
    const { result } = renderHook(() => useTheme());
    act(() => result.current.toggle());
    expect(result.current.preference).toBe("light");
    expect(localStorage.getItem(KEY)).toBe("light");
    act(() => result.current.toggle());
    expect(result.current.preference).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("works without a theme-color meta tag", () => {
    fakeMedia(false);
    expect(() => renderHook(() => useTheme())).not.toThrow();
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("does not touch the native window outside the desktop app", () => {
    fakeMedia(true);
    renderHook(() => useTheme());
    expect(getCurrentWindow).not.toHaveBeenCalled();
  });

  it("matches the native title bar to the theme on desktop", async () => {
    (window as unknown as Win).__TAURI_INTERNALS__ = {};
    fakeMedia(false);
    const { result } = renderHook(() => useTheme());
    await vi.waitFor(() => expect(setTheme).toHaveBeenLastCalledWith("light"));
    act(() => result.current.setPreference("dark"));
    await vi.waitFor(() => expect(setTheme).toHaveBeenLastCalledWith("dark"));
  });

  it("ignores a native title bar failure", async () => {
    (window as unknown as Win).__TAURI_INTERNALS__ = {};
    setTheme.mockRejectedValue(new Error("no window"));
    fakeMedia(false);
    renderHook(() => useTheme());
    await vi.waitFor(() => expect(setTheme).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});
