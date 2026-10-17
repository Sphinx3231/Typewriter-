// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bridge, NativeUpdate } from "../desktop/bridge";

/** The fake desktop bridge each test hands the status window. */
const fake = vi.hoisted(() => ({
  make: null as null | (() => Promise<unknown>),
}));

vi.mock("../desktop/bridge", () => ({ tauriBridge: () => fake.make!() }));

interface Fake {
  bridge: Bridge;
  control: ReturnType<typeof vi.fn>;
  showMain: ReturnType<typeof vi.fn>;
  push: (u: Partial<NativeUpdate>) => void;
}

function makeBridge(opts: { state?: false | (() => Promise<NativeUpdate | null>); controlFails?: boolean } = {}): Fake {
  const listeners = new Set<(u: NativeUpdate) => void>();
  const control = vi.fn(async () => {
    if (opts.controlFails) throw new Error("no session");
  });
  const showMain = vi.fn(async () => {});
  const bridge: Bridge = {
    support: async () => ({ available: true, state: "ok", platform: "linux", message: "ok" }),
    start: async () => ({ shortcutRegistered: true }),
    control,
    readClipboard: async () => "",
    showMain,
    onUpdate: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  if (opts.state !== false) bridge.state = opts.state ?? (async () => null);
  return {
    bridge,
    control,
    showMain,
    push: (u) => {
      const full = update(u);
      act(() => {
        for (const fn of listeners) fn(full);
      });
    },
  };
}

const update = (u: Partial<NativeUpdate>): NativeUpdate => ({
  phase: "typing",
  index: 0,
  elapsedMs: 0,
  totalMs: 0,
  countdownMs: 0,
  target: null,
  reason: null,
  message: null,
  ...u,
});

/** Boots the status window (it renders into #hud when its module loads). */
async function boot(f: Fake | (() => Promise<unknown>)) {
  fake.make = typeof f === "function" ? f : async () => f.bridge;
  document.body.innerHTML = '<div id="hud"></div>';
  vi.resetModules();
  await act(async () => {
    await import("./main");
  });
  await waitFor(() => expect(screen.getByTestId("hud")).toBeTruthy());
}

const label = () => screen.getByTestId("hud-label").textContent;
const detail = () => screen.getByTestId("hud-detail").textContent;
const hud = () => screen.getByTestId("hud");
const buttons = () =>
  within(hud())
    .queryAllByRole("button")
    .map((b) => b.textContent);

beforeEach(() => {
  delete document.documentElement.dataset.theme;
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("status window (HUD)", () => {
  it("starts in 'Getting ready' with nothing typed, no percentage, and Stop only", async () => {
    const f = makeBridge();
    await boot(f);
    expect(label()).toBe("Getting ready");
    expect(detail()).toBe("Getting the keyboard ready. Nothing is typed yet.");
    expect(hud().dataset.phase).toBe("preparing");
    expect(screen.queryByTestId("hud-pct")).toBeNull();
    expect(screen.getByTestId("hud-left").textContent).toBe("");
    expect(buttons()).toEqual(["Stop"]);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("0");
    expect(screen.getByTestId("hud-hint").textContent).toBe("Stop: Ctrl+Shift+Space or mouse to the top-left corner");
  });

  it("shows each stage's label and explanation as the engine reports it", async () => {
    const f = makeBridge();
    await boot(f);

    f.push({ phase: "preparing", message: "Setting up 2 of 5 characters…" });
    expect(label()).toBe("Getting ready");
    expect(detail()).toBe("Setting up 2 of 5 characters… Nothing is typed yet.");
    f.push({ phase: "preparing" });
    expect(detail()).toBe("Getting the keyboard ready… Nothing is typed yet.");

    f.push({ phase: "waiting" });
    expect(label()).toBe("Click into your document");
    expect(detail()).toBe("Typing starts after the countdown. Nothing is typed yet.");
    expect(buttons()).toEqual(["Stop"]);

    f.push({ phase: "countdown", countdownMs: 2500 });
    expect(label()).toBe("Starting in 3");
    expect(detail()).toBe("Keep the cursor where the text should go.");
    f.push({ phase: "countdown", countdownMs: 0 });
    expect(label()).toBe("Starting in 1"); // never "0"

    f.push({ phase: "typing", target: { windowId: "1", processId: 9, appName: "gedit", title: "notes.txt" } });
    expect(label()).toBe("Typing");
    expect(detail()).toBe("Into “notes.txt”");
    f.push({ phase: "typing", message: "Typing into notes", target: { windowId: "1", processId: 9, appName: "gedit", title: "notes.txt" } });
    expect(detail()).toBe("Typing into notes");
    f.push({ phase: "typing" });
    expect(detail()).toBe("");

    f.push({ phase: "paused" });
    expect(label()).toBe("Paused");
    expect(detail()).toBe("Press Resume, then click back into your document.");
    f.push({ phase: "paused", message: "Paused." });
    expect(detail()).toBe("Press Resume, then click back into your document.");
    f.push({ phase: "paused", message: "Focus moved to another window, so typing paused." });
    expect(detail()).toBe("Focus moved to another window, so typing paused.");

    f.push({ phase: "resuming", countdownMs: 1200, message: "Click back into your document." });
    expect(label()).toBe("Resuming 2");
    expect(detail()).toBe("Click back into your document.");
    f.push({ phase: "resuming", countdownMs: 0 });
    expect(label()).toBe("Resuming");
    expect(detail()).toBe("");

    f.push({ phase: "completed" });
    expect(label()).toBe("All keys sent");
    expect(detail()).toMatch(/^Not checked yet: copy the text from your document, then press Check in Typewriter\.$/);

    f.push({ phase: "stopped" });
    expect(label()).toBe("Stopped");
    expect(detail()).toBe("Keys already typed stay in your document.");
    f.push({ phase: "stopped", message: "Stopped: the mouse reached the top-left corner." });
    expect(detail()).toBe("Stopped: the mouse reached the top-left corner.");

    f.push({ phase: "failed", message: "No keys were sent, so nothing was typed." });
    expect(label()).toBe("Couldn't type");
    expect(detail()).toBe("No keys were sent, so nothing was typed.");
    expect(hud().className).toContain("hud--failed");
    f.push({ phase: "failed" });
    expect(detail()).toBe("");
  });

  it("shows progress, percentage and time left while running, capped at 100%", async () => {
    const f = makeBridge();
    await boot(f);
    f.push({ phase: "typing", elapsedMs: 15_000, totalMs: 60_000 });
    expect(screen.getByTestId("hud-pct").textContent).toBe("25%");
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("25");
    expect(screen.getByTestId("hud-left").textContent).toBe("0:45 left");
    f.push({ phase: "typing", elapsedMs: 59_999, totalMs: 60_000 });
    expect(screen.getByTestId("hud-pct").textContent).toBe("99%");
    expect(screen.getByTestId("hud-left").textContent).toBe("0:00 left");
    f.push({ phase: "typing", elapsedMs: 70_000, totalMs: 60_000 });
    expect(screen.getByTestId("hud-pct").textContent).toBe("100%");
    expect(screen.getByTestId("hud-left").textContent).toBe("0:00 left");
    // Once finished, no time left is shown, but the percentage stays.
    f.push({ phase: "completed", elapsedMs: 60_000, totalMs: 60_000 });
    expect(screen.getByTestId("hud-left").textContent).toBe("");
    expect(screen.getByTestId("hud-pct").textContent).toBe("100%");
  });

  it("warns when the stop shortcut couldn't be registered", async () => {
    const f = makeBridge();
    await boot(f);
    f.push({ phase: "waiting", shortcutRegistered: false });
    expect(screen.getByTestId("hud-hint").textContent).toBe("No stop shortcut: use Stop or move the mouse to the top-left corner");
    expect(screen.queryByText("Ctrl+Shift+Space")).toBeNull();
    f.push({ phase: "waiting", shortcutRegistered: true });
    expect(screen.getByText("Ctrl+Shift+Space").tagName).toBe("KBD");
  });

  it("offers Pause only while typing, Resume only while paused, Stop while running, and sends them", async () => {
    const f = makeBridge();
    await boot(f);
    f.push({ phase: "typing", totalMs: 1000 });
    expect(buttons()).toEqual(["Pause", "Stop"]);
    fireEvent.click(screen.getByTestId("hud-pause"));
    expect(f.control).toHaveBeenLastCalledWith("pause");

    f.push({ phase: "paused" });
    expect(buttons()).toEqual(["Resume", "Stop"]);
    fireEvent.click(screen.getByTestId("hud-resume"));
    expect(f.control).toHaveBeenLastCalledWith("resume");

    f.push({ phase: "resuming", countdownMs: 2000 });
    expect(buttons()).toEqual(["Stop"]);
    fireEvent.click(screen.getByTestId("hud-stop"));
    expect(f.control).toHaveBeenLastCalledWith("stop");
    expect(f.showMain).not.toHaveBeenCalled();
  });

  it.each(["completed", "stopped", "failed"] as const)("after the session ends (%s) it only offers to open Typewriter", async (phase) => {
    const f = makeBridge();
    await boot(f);
    f.push({ phase });
    expect(buttons()).toEqual(["Open Typewriter"]);
    fireEvent.click(screen.getByTestId("hud-open"));
    expect(f.showMain).toHaveBeenCalledTimes(1);
    expect(f.control).not.toHaveBeenCalled();
  });

  it("a control that fails (session already over) is swallowed", async () => {
    const f = makeBridge({ controlFails: true });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      await boot(f);
      f.push({ phase: "typing" });
      fireEvent.click(screen.getByTestId("hud-stop"));
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      expect(f.control).toHaveBeenCalledWith("stop");
      expect(unhandled).not.toHaveBeenCalled();
      expect(label()).toBe("Typing");
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("Stop clicked before the bridge is ready does nothing (and doesn't throw)", async () => {
    let resolve: (b: Bridge) => void = () => {};
    const pending = new Promise<Bridge>((r) => (resolve = r));
    await boot(() => pending);
    expect(buttons()).toEqual(["Stop"]);
    fireEvent.click(screen.getByTestId("hud-stop"));
    const f = makeBridge();
    await act(async () => resolve(f.bridge));
    expect(f.control).not.toHaveBeenCalled();
    // Once connected, Stop works.
    fireEvent.click(screen.getByTestId("hud-stop"));
    expect(f.control).toHaveBeenCalledWith("stop");
  });

  it("catches up with a session that moved on before the window opened", async () => {
    const f = makeBridge({ state: async () => update({ phase: "countdown", countdownMs: 4000 }) });
    await boot(f);
    await waitFor(() => expect(label()).toBe("Starting in 4"));
  });

  it("a live update that arrives first wins over the late catch-up", async () => {
    const answers: ((u: NativeUpdate | null) => void)[] = [];
    const f = makeBridge({ state: () => new Promise((r) => answers.push(r)) });
    await boot(f);
    await waitFor(() => expect(answers.length).toBeGreaterThan(0));
    const answer = (u: NativeUpdate) => answers.forEach((a) => a(u));
    f.push({ phase: "typing", totalMs: 1000, elapsedMs: 500 });
    await act(async () => answer(update({ phase: "countdown", countdownMs: 3000 })));
    expect(label()).toBe("Typing");
    expect(screen.getByTestId("hud-pct").textContent).toBe("50%");
  });

  it("stays in 'Getting ready' when there is no session to catch up with, or the query fails", async () => {
    await boot(makeBridge({ state: async () => null }));
    expect(label()).toBe("Getting ready");
    await boot(makeBridge({ state: async () => Promise.reject(new Error("not running")) }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(label()).toBe("Getting ready");
    // A bridge without a state query (older shell) still receives live updates.
    const f = makeBridge({ state: false });
    await boot(f);
    f.push({ phase: "waiting" });
    expect(label()).toBe("Click into your document");
  });

  it("follows theme changes made in the main window", async () => {
    const mq = vi.fn(() => ({ matches: true }));
    vi.stubGlobal("matchMedia", mq);
    await boot(makeBridge());
    const root = document.documentElement;
    const store = (key: string | null, newValue: string | null) => act(() => void dispatchEvent(new StorageEvent("storage", { key, newValue })));

    store("typewriter:theme", "dark");
    expect(root.dataset.theme).toBe("dark");
    store("typewriter:theme", "light");
    expect(root.dataset.theme).toBe("light");
    // Other keys are ignored.
    store("typewriter:text", "dark");
    expect(root.dataset.theme).toBe("light");
    // "System": follows the OS preference.
    store("typewriter:theme", null);
    expect(root.dataset.theme).toBe("dark");
    expect(mq).toHaveBeenCalledWith("(prefers-color-scheme: dark)");
    mq.mockReturnValue({ matches: false });
    store("typewriter:theme", null);
    expect(root.dataset.theme).toBe("light");
  });
});
