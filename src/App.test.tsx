// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { ToastProvider } from "./ui/controls";

const TEXT = "Hello there, world.";

function renderApp() {
  return render(
    <ToastProvider>
      <App />
    </ToastProvider>,
  );
}

const editor = () => screen.getByTestId("editor") as HTMLTextAreaElement;
const status = () => screen.getAllByTestId("status")[0].textContent;
const key = (init: KeyboardEventInit) => act(() => void fireEvent.keyDown(window, init));
const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

/** Puts text in the editor and lets the deferred planning settle. */
function typeText(t: string) {
  fireEvent.change(editor(), { target: { value: t } });
  advance(50);
}

/** Clean, fast settings so a whole session finishes in well under a second of fake time. */
function seedFastSettings() {
  localStorage.setItem(
    "typewriter:settings",
    JSON.stringify({ timingMode: "speed", wpm: 400, rhythm: false, pauses: false, mistakes: "off", sound: false }),
  );
}

beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, "", "/");
  document.title = "";
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("App (browser preview)", () => {
  it("shows the empty state and refuses to start without text", () => {
    renderApp();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Workspace");
    expect(screen.getByText("Your text will be typed here")).toBeTruthy();
    expect((screen.getByTestId("btn-start") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Add some text to start.")).toBeTruthy();
    expect(document.title).toBe("Typewriter");
    // Ctrl+Enter with nothing to type does nothing.
    key({ key: "Enter", ctrlKey: true });
    expect(status()).toContain("No text");
    // The web build explains that other apps need the desktop app or extension.
    expect(screen.getByText(/use the Typewriter Chrome extension or desktop app/)).toBeTruthy();
  });

  it("types the text out with Ctrl+Enter, pauses and resumes with Space, and finishes with an exact copy", async () => {
    seedFastSettings();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderApp();
    typeText(TEXT);
    expect(screen.getByText(/Ready to type 3 words/)).toBeTruthy();
    expect(status()).toContain("Ready");

    key({ key: "Enter", ctrlKey: true });
    expect(status()).toContain("Typing");
    expect(document.title).toMatch(/^\d+% · Typewriter$/);
    expect(editor().readOnly).toBe(true);
    // The nav marks the workspace as live.
    expect(screen.getByLabelText("Playback running")).toBeTruthy();

    // Editing is locked while typing.
    fireEvent.change(editor(), { target: { value: "changed" } });
    expect(editor().value).toBe(TEXT);

    // Ctrl+Enter while playing changes nothing.
    key({ key: "Enter", ctrlKey: true });
    expect(status()).toContain("Typing");

    advance(100);
    (document.activeElement as HTMLElement | null)?.blur();
    key({ key: " " });
    expect(status()).toContain("Paused");
    expect(document.title).toMatch(/^Paused \d+% · Typewriter$/);
    expect(screen.getByText(/Paused at \d+:\d+/)).toBeTruthy();
    advance(5000);
    expect(status()).toContain("Paused");

    key({ key: " " });
    expect(status()).toContain("Typing");
    advance(10_000);
    expect(status()).toContain("Complete");
    expect(document.title).toBe("Done · Typewriter");
    expect(screen.getByTestId("playback-text").textContent).toBe(TEXT);
    expect(screen.getByTestId("verified-badge").textContent).toContain("matches your text exactly");

    // Ctrl+Shift+C copies the original text and confirms with a toast.
    key({ key: "C", ctrlKey: true, shiftKey: true });
    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith(TEXT);
    expect(screen.getByText(`Copied ${TEXT.length} characters`)).toBeTruthy();

    // The lowercase key works too (Caps Lock or layouts that report it that way).
    key({ key: "c", metaKey: true, shiftKey: true });
    await act(async () => {});
    expect(writeText).toHaveBeenCalledTimes(2);

    // Space after completion does nothing.
    key({ key: " " });
    expect(status()).toContain("Complete");

    // The session was recorded in History.
    act(() => void fireEvent.click(screen.getByTestId("nav-history")));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("History");
  });

  it("reports a failed copy with an error toast", async () => {
    seedFastSettings();
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn(async () => Promise.reject(new Error("blocked"))) }, configurable: true });
    renderApp();
    typeText("abc");
    key({ key: "Enter", metaKey: true });
    advance(5000);
    expect(status()).toContain("Complete");
    act(() => void fireEvent.click(screen.getByTestId("btn-copy")));
    await act(async () => {});
    expect(screen.getByText("Couldn't copy. Select the text and copy it manually.")).toBeTruthy();
  });

  it("resumes a paused session with Ctrl+Enter and stops with Escape", () => {
    seedFastSettings();
    renderApp();
    typeText("A longer sentence that takes a moment to type out completely.");
    key({ key: "Enter", ctrlKey: true });
    advance(50);
    act(() => void fireEvent.click(screen.getByTestId("btn-pause")));
    expect(status()).toContain("Paused");
    key({ key: "Enter", ctrlKey: true });
    expect(status()).toContain("Typing");
    // Escape stops; the partial output stays and the stop percentage is shown.
    key({ key: "Escape" });
    expect(status()).toContain("Stopped");
    expect(screen.getByText(/Stopped at \d+%/)).toBeTruthy();
    // Escape when nothing runs is ignored.
    key({ key: "Escape" });
    expect(status()).toContain("Stopped");
    // Ctrl+Enter starts again from the beginning.
    key({ key: "Enter", ctrlKey: true });
    expect(status()).toContain("Typing");
  });

  it("does not pause when Space is pressed in a text field, a button or a switch", () => {
    seedFastSettings();
    renderApp();
    typeText("A longer sentence that takes a moment to type out completely.");
    key({ key: "Enter", ctrlKey: true });
    for (const el of [editor(), screen.getByTestId("btn-stop"), screen.getByTestId("theme-switch")]) {
      el.focus();
      key({ key: " " });
      expect(status()).toContain("Typing");
    }
    // A number input counts as typing; a checkbox-like range does not.
    const input = document.createElement("input");
    input.type = "text";
    document.body.appendChild(input);
    input.focus();
    key({ key: " " });
    expect(status()).toContain("Typing");
    input.type = "range";
    key({ key: " " });
    expect(status()).toContain("Paused");
    input.remove();
    // Ctrl+Space is not the pause shortcut.
    (document.activeElement as HTMLElement | null)?.blur();
    key({ key: " ", ctrlKey: true });
    expect(status()).toContain("Paused");
    // A contenteditable element counts as typing too.
    const ce = document.createElement("div");
    Object.defineProperty(ce, "isContentEditable", { value: true });
    ce.tabIndex = 0;
    document.body.appendChild(ce);
    ce.focus();
    key({ key: " " });
    expect(status()).toContain("Paused");
    ce.remove();
  });

  it("switches views with Alt+1/2/3, the header button, the tab bar and the URL hash", () => {
    seedFastSettings();
    renderApp();
    const h1 = () => screen.getByRole("heading", { level: 1 }).textContent;
    key({ key: "2", altKey: true });
    expect(h1()).toBe("History");
    expect(location.hash).toBe("#/history");
    key({ key: "3", altKey: true });
    expect(h1()).toBe("Settings");
    expect(location.hash).toBe("#/settings");
    key({ key: "1", altKey: true });
    expect(h1()).toBe("Workspace");
    expect(location.hash).toBe("");

    // Header settings button toggles between Settings and the workspace.
    act(() => void fireEvent.click(screen.getByTestId("header-settings")));
    expect(h1()).toBe("Settings");
    act(() => void fireEvent.click(screen.getByTestId("header-settings")));
    expect(h1()).toBe("Workspace");
    // Going to the view that is already shown leaves the URL alone.
    const replace = vi.spyOn(history, "replaceState");
    act(() => void fireEvent.click(screen.getByTestId("nav-workspace")));
    expect(replace).not.toHaveBeenCalled();

    // Mobile tab bar.
    const tabbar = document.querySelector(".tabbar") as HTMLElement;
    act(() => void fireEvent.click(within(tabbar).getByText("History")));
    expect(h1()).toBe("History");

    // Browser navigation through the hash.
    act(() => {
      location.hash = "#/settings";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(h1()).toBe("Settings");
    act(() => {
      location.hash = "#/nowhere";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(h1()).toBe("Workspace");
  });

  it("opens on the view named in the URL and offers a way back to a running session", () => {
    seedFastSettings();
    history.replaceState(null, "", "/#history");
    renderApp();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("History");
    act(() => void fireEvent.click(screen.getByTestId("nav-workspace")));
    typeText("A longer sentence that takes a moment to type out completely.");
    act(() => void fireEvent.click(screen.getByTestId("btn-start")));
    // Starting from another view with Ctrl+Enter brings the workspace back.
    key({ key: "Escape" });
    key({ key: "2", altKey: true });
    key({ key: "Enter", ctrlKey: true });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Workspace");
    key({ key: "3", altKey: true });
    const live = screen.getByRole("button", { name: /Typing \d+%/ });
    act(() => void fireEvent.click(live));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Workspace");
  });

  it("toggles between light and dark themes and remembers the choice", () => {
    renderApp();
    const sw = screen.getByTestId("theme-switch");
    const before = document.documentElement.dataset.theme;
    act(() => void fireEvent.click(sw));
    const after = document.documentElement.dataset.theme;
    expect(after).not.toBe(before);
    expect(sw.getAttribute("aria-checked")).toBe(String(after === "dark"));
    expect(localStorage.getItem("typewriter:theme")).toBe(after);
    act(() => void fireEvent.click(sw));
    expect(document.documentElement.dataset.theme).toBe(before);
  });

  it("shows a playback error when the output would not match the text", async () => {
    seedFastSettings();
    renderApp();
    typeText("abc");
    // Corrupt the planned timeline so the engine's final integrity check fails.
    const engine = await import("./engine");
    const real = engine.PlaybackController.prototype.load;
    const spy = vi.spyOn(engine.PlaybackController.prototype, "load").mockImplementation(function (this: InstanceType<typeof engine.PlaybackController>, src, tl) {
      return real.call(this, src + "!", tl);
    });
    key({ key: "Enter", ctrlKey: true });
    advance(5000);
    spy.mockRestore();
    expect(status()).toContain("Error");
    expect(screen.getByRole("alert").textContent).toContain("Playback output differs from your text");
    expect(document.title).toBe("Typewriter");
  });
});
