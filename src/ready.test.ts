// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { show, getCurrentWindow } = vi.hoisted(() => {
  const show = vi.fn();
  return { show, getCurrentWindow: vi.fn(() => ({ show })) };
});
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow }));

type Win = Record<string, unknown>;

/** markReady keeps a module-level "done" flag, so each test gets a fresh module. */
async function freshMarkReady() {
  vi.resetModules();
  return (await import("./ready")).markReady;
}

function addBoot() {
  const boot = document.createElement("div");
  boot.id = "boot";
  document.body.appendChild(boot);
  return boot;
}

beforeEach(() => {
  show.mockReset();
  show.mockResolvedValue(undefined);
  getCurrentWindow.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  delete (window as unknown as Win).__TAURI_INTERNALS__;
  document.body.innerHTML = "";
});

describe("markReady", () => {
  it("fades the launch splash out and removes it after the transition", async () => {
    const markReady = await freshMarkReady();
    vi.useFakeTimers();
    const boot = addBoot();
    markReady();
    expect(boot.classList.contains("is-done")).toBe(true);
    expect(document.getElementById("boot")).toBe(boot);
    vi.advanceTimersByTime(399);
    expect(document.getElementById("boot")).toBe(boot);
    vi.advanceTimersByTime(1);
    expect(document.getElementById("boot")).toBeNull();
    expect(getCurrentWindow).not.toHaveBeenCalled(); // not the desktop app
  });

  it("runs only once", async () => {
    const markReady = await freshMarkReady();
    markReady();
    const late = addBoot();
    markReady();
    expect(late.classList.contains("is-done")).toBe(false);
  });

  it("works when there is no splash element", async () => {
    const markReady = await freshMarkReady();
    expect(() => markReady()).not.toThrow();
  });

  it("shows the hidden desktop window", async () => {
    (window as unknown as Win).__TAURI_INTERNALS__ = {};
    const markReady = await freshMarkReady();
    addBoot();
    markReady();
    await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(1));
    expect(document.getElementById("boot")?.classList.contains("is-done")).toBe(true);
  });

  it("ignores a failure to show the desktop window", async () => {
    (window as unknown as Win).__TAURI_INTERNALS__ = {};
    show.mockRejectedValue(new Error("window gone"));
    const markReady = await freshMarkReady();
    markReady();
    await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(1));
    // Let the rejection settle; an unhandled rejection would fail the run.
    await new Promise((r) => setTimeout(r, 0));
  });
});
