// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bridge, NativeUpdate, Support } from "./desktop/bridge";
import App from "./App";
import { ToastProvider } from "./ui/controls";

const env = vi.hoisted(() => {
  // The desktop shell announces itself this way; the app then offers typing into other apps.
  (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
  return { bridge: null as unknown };
});

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ show: async () => {}, setTheme: async () => {}, onCloseRequested: async () => () => {} }),
}));
vi.mock("./desktop/bridge", async (orig) => ({ ...(await orig<typeof import("./desktop/bridge")>()), tauriBridge: async () => env.bridge }));
vi.mock("./ui/QuitGuard", () => ({ QuitGuard: () => <div data-testid="quit-guard" /> }));

const OK: Support = { available: true, state: "ok", platform: "linux", message: "Typewriter can type into other apps." };

function fakeBridge(support: Support = OK) {
  let push: (u: NativeUpdate) => void = () => {};
  let token: number | undefined;
  const bridge = {
    support: vi.fn(async (_prompt: boolean) => support),
    start: vi.fn(async (_e: unknown[], _c: number, _m: boolean, _s?: string, session?: number) => {
      token = session;
      return { shortcutRegistered: true };
    }),
    control: vi.fn(async (_c: "pause" | "resume" | "stop") => {}),
    readClipboard: vi.fn(async () => ""),
    showMain: vi.fn(async () => {}),
    onUpdate: (fn: (u: NativeUpdate) => void) => {
      push = fn;
      return () => {};
    },
  };
  const update = (u: Partial<NativeUpdate>) =>
    act(() => push({ phase: "typing", index: 0, elapsedMs: 0, totalMs: 0, countdownMs: 0, target: null, reason: null, message: null, session: token, ...u }));
  return { bridge: bridge satisfies Bridge, update };
}

const TEXT = "Dear team, see you soon.";
const status = () => screen.getAllByTestId("status")[0].textContent;
const key = (init: KeyboardEventInit) => act(() => void fireEvent.keyDown(window, init));
const flush = () => act(async () => {});

async function renderDesktop(f: ReturnType<typeof fakeBridge>) {
  env.bridge = f.bridge;
  localStorage.setItem("typewriter:settings", JSON.stringify({ timingMode: "speed", wpm: 300, rhythm: false, pauses: false, mistakes: "off" }));
  render(
    <ToastProvider>
      <App />
    </ToastProvider>,
  );
  await flush();
}

beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
});

describe("App on the desktop", () => {
  it("guards quitting and types into another app from arming to a verified document", async () => {
    const f = fakeBridge();
    await renderDesktop(f);
    expect(screen.getByTestId("quit-guard")).toBeTruthy();
    expect(screen.getByText("Typed out keystroke by keystroke.")).toBeTruthy();

    act(() => void fireEvent.click(screen.getByRole("radio", { name: "Into another app" })));
    expect(screen.getByText("What has been sent to the other app, key by key.")).toBeTruthy();
    expect(screen.getByTestId("ext-support").textContent).toContain(OK.message);
    // The guide only replaces the empty state once there is text.
    expect(screen.queryByTestId("ext-guide")).toBeNull();
    fireEvent.change(screen.getByTestId("editor"), { target: { value: TEXT } });
    await flush();
    expect(screen.getByTestId("ext-guide").textContent).toContain("Type into another app");

    const start = screen.getByTestId("btn-start");
    expect(start.textContent).toBe("Type into app");
    act(() => void fireEvent.click(start));
    await flush();
    expect(f.bridge.start).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("ext-preparing")).toBeTruthy();
    expect(screen.getByTestId("btn-cancel")).toBeTruthy();

    f.update({ phase: "waiting" });
    expect(screen.getByTestId("ext-status").dataset.phase).toBe("waiting");
    f.update({ phase: "countdown", countdownMs: 3000 });
    expect(screen.getByTestId("ext-countdown").textContent).toContain("Typing starts in 3");

    const target = { windowId: "1", processId: 2, appName: "Writer", title: "Letter.odt" };
    f.update({ phase: "typing", index: 5, elapsedMs: 100, target });
    expect(screen.getByTestId("ext-status").textContent).toContain("Typing into Letter.odt");
    expect(screen.getByTestId("playback-text").textContent).toBe(TEXT.slice(0, 5));

    // Space pauses through the typing engine; Ctrl+Enter resumes.
    (document.activeElement as HTMLElement | null)?.blur();
    key({ key: " " });
    expect(f.bridge.control).toHaveBeenLastCalledWith("pause");
    f.update({ phase: "paused", index: 5, elapsedMs: 100, message: "Paused." });
    expect(status()).toContain("Paused");
    key({ key: "Enter", ctrlKey: true });
    expect(f.bridge.control).toHaveBeenLastCalledWith("resume");
    f.update({ phase: "typing", index: 10, elapsedMs: 200 });

    // The destination can't be switched mid-session.
    expect(screen.getByText("Change this after the current session ends.")).toBeTruthy();

    const n = TEXT.length;
    f.update({ phase: "completed", index: n, elapsedMs: 1000 });
    expect(screen.getByTestId("playback-text").textContent).toBe(TEXT);
    expect(screen.getByTestId("sent-badge")).toBeTruthy();
    expect(document.title).toBe("Done · Typewriter");

    // The user copies the text from the document and checks it.
    f.bridge.readClipboard.mockResolvedValueOnce(TEXT);
    await act(async () => void fireEvent.click(screen.getByTestId("btn-verify")));
    expect(screen.getByTestId("ext-verified")).toBeTruthy();
    expect(screen.getByText("Verified in your document")).toBeTruthy();
    expect(screen.getByTestId("btn-start").textContent).toBe("Type again");
  });

  it("stops typing with Escape and explains that typed keys stay in the document", async () => {
    const f = fakeBridge();
    localStorage.setItem("typewriter:prefs", JSON.stringify({ destination: "external" }));
    await renderDesktop(f);
    fireEvent.change(screen.getByTestId("editor"), { target: { value: TEXT } });
    await flush();
    key({ key: "Enter", ctrlKey: true });
    await flush();
    f.update({ phase: "typing", index: 3, elapsedMs: 50 });
    key({ key: "Escape" });
    expect(f.bridge.control).toHaveBeenLastCalledWith("stop");
    f.update({ phase: "stopped", index: 3, elapsedMs: 50, reason: "user" });
    expect(status()).toContain("Stopped");
    expect(screen.getByTestId("ext-status").textContent).toBe("Stopped. Keys already typed stay in your document.");
  });

  it("asks for access when the system denied it, and starts once it is granted", async () => {
    const f = fakeBridge({ available: false, state: "permission-denied", platform: "macos", message: "Allow Typewriter in Accessibility settings." });
    localStorage.setItem("typewriter:prefs", JSON.stringify({ destination: "external" }));
    await renderDesktop(f);
    fireEvent.change(screen.getByTestId("editor"), { target: { value: TEXT } });
    await flush();
    expect((screen.getByTestId("btn-start") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText("Allow Typewriter in Accessibility settings.").length).toBeGreaterThan(0);
    f.bridge.support.mockResolvedValueOnce(OK);
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Grant access" })));
    expect(f.bridge.support).toHaveBeenLastCalledWith(true);
    expect((screen.getByTestId("btn-start") as HTMLButtonElement).disabled).toBe(false);
  });
});
