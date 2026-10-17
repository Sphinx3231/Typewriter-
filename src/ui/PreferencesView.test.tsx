// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../engine";
import { DEFAULT_PREFS, type HistoryEntry, type Session } from "../state/useSession";
import type { ThemePreference } from "../theme/theme";
import { ToastProvider } from "./controls";
import { PreferencesView } from "./PreferencesView";

const sound = vi.hoisted(() => ({ instances: 0, unlock: vi.fn(), setEnabled: vi.fn(), setVolume: vi.fn(), play: vi.fn() }));
vi.mock("../audio/sound", () => ({
  TypingSound: class {
    constructor() {
      sound.instances++;
    }
    unlock = sound.unlock;
    setEnabled = sound.setEnabled;
    setVolume = sound.setVolume;
    play = sound.play;
  },
}));

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

const historyItem = { id: "a", status: "completed" } as HistoryEntry;

function fakeSession(over: Partial<Session> = {}): Session {
  return {
    prefs: { ...DEFAULT_PREFS },
    updatePrefs: vi.fn(),
    settings: { ...DEFAULT_SETTINGS },
    updateSettings: vi.fn(),
    history: [historyItem],
    clearHistory: vi.fn(),
    resetPreferences: vi.fn(),
    ...over,
  } as unknown as Session;
}

function renderPrefs(session = fakeSession(), themePreference: ThemePreference = "system") {
  const onThemePreference = vi.fn();
  const utils = render(
    <ToastProvider>
      <PreferencesView session={session} themePreference={themePreference} onThemePreference={onThemePreference} />
    </ToastProvider>,
  );
  return { ...utils, session, onThemePreference };
}

const toasts = () => [...screen.getByRole("status").querySelectorAll(".toast")].map((t) => [t.textContent, t.className]);

describe("PreferencesView", () => {
  it("shows the theme choice and reports a new one", async () => {
    const { onThemePreference } = renderPrefs(undefined, "dark");
    const group = screen.getByRole("radiogroup", { name: "Theme" });
    expect(group).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Dark" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("System follows your device until you pick light or dark.")).toBeTruthy();
    await userEvent.click(screen.getByRole("radio", { name: "Light" }));
    expect(onThemePreference).toHaveBeenCalledWith("light");
  });

  it("toggles typing sounds through the session settings", async () => {
    const { session } = renderPrefs(fakeSession({ settings: { ...DEFAULT_SETTINGS, sound: true } }));
    const sw = screen.getByRole("switch", { name: "Typing sounds" });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    await userEvent.click(sw);
    expect(session.updateSettings).toHaveBeenCalledWith({ sound: false });
  });

  it("changes the volume with the slider", () => {
    const { session } = renderPrefs(fakeSession({ prefs: { ...DEFAULT_PREFS, volume: 0.35 } }));
    const slider = screen.getByRole("slider", { name: "Volume" }) as HTMLInputElement;
    expect(slider.value).toBe("0.35");
    expect(slider.getAttribute("aria-valuetext")).toBe("35%");
    expect(slider.style.getPropertyValue("--fill")).toBe("35%");
    fireEvent.change(slider, { target: { value: "0.8" } });
    expect(session.updatePrefs).toHaveBeenCalledWith({ volume: 0.8 });
  });

  it("plays a short test word at the current volume, reusing one sound engine", () => {
    vi.useFakeTimers();
    renderPrefs(fakeSession({ prefs: { ...DEFAULT_PREFS, volume: 0.4 } }));
    const test = screen.getByRole("button", { name: "Test" });
    fireEvent.click(test);
    expect(sound.unlock).toHaveBeenCalledTimes(1);
    expect(sound.setEnabled).toHaveBeenCalledWith(true);
    expect(sound.setVolume).toHaveBeenCalledWith(0.4);
    expect(sound.play).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(110 * 11);
    });
    const typed = sound.play.mock.calls.map(([ev]) => ev.text).join("");
    expect(typed).toBe("typewriter ");
    expect(sound.play.mock.calls[0][0]).toMatchObject({ kind: "type", fix: false });
    const created = sound.instances;
    fireEvent.click(test);
    expect(sound.instances).toBe(created);
    expect(sound.unlock).toHaveBeenCalledTimes(2);
  });

  it("toggles the privacy switches", async () => {
    const { session } = renderPrefs();
    const remember = screen.getByRole("switch", { name: "Remember my text on this device" });
    expect(remember.getAttribute("aria-checked")).toBe("false");
    await userEvent.click(remember);
    expect(session.updatePrefs).toHaveBeenCalledWith({ rememberText: true });
    const keep = screen.getByRole("switch", { name: "Keep session history" });
    expect(keep.getAttribute("aria-checked")).toBe("true");
    await userEvent.click(keep);
    expect(session.updatePrefs).toHaveBeenCalledWith({ keepHistory: false });
  });

  it("clears history after confirming and confirms with a toast", async () => {
    const { session } = renderPrefs();
    await userEvent.click(screen.getByRole("button", { name: "Clear history" }));
    expect(session.clearHistory).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Delete all history?" }));
    expect(session.clearHistory).toHaveBeenCalledTimes(1);
    expect(toasts()).toEqual([["History cleared", "toast toast--success"]]);
  });

  it("disables clearing when there is no history", () => {
    renderPrefs(fakeSession({ history: [] }));
    expect((screen.getByRole("button", { name: "Clear history" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("resets settings and the theme after confirming", async () => {
    const { session, onThemePreference } = renderPrefs(undefined, "dark");
    await userEvent.click(screen.getByRole("button", { name: "Reset settings" }));
    await userEvent.click(screen.getByRole("button", { name: "Reset all settings?" }));
    expect(session.resetPreferences).toHaveBeenCalledTimes(1);
    expect(onThemePreference).toHaveBeenCalledWith("system");
    expect(toasts()).toEqual([["Settings reset to defaults", "toast toast--success"]]);
  });

  it("lists the keyboard shortcuts with each key marked up", () => {
    renderPrefs();
    const rows = [...document.querySelectorAll(".shortcuts__row")];
    expect(rows).toHaveLength(5);
    expect(rows[0].querySelector("dd")?.textContent).toBe("Start, or start again");
    expect([...rows[0].querySelectorAll("kbd")].map((k) => k.textContent)).toEqual(["Ctrl / ⌘", "Enter"]);
    expect(rows[0].querySelector("dt")?.textContent).toBe("Ctrl / ⌘ + Enter");
    expect([...rows[1].querySelectorAll("kbd")].map((k) => k.textContent)).toEqual(["Space"]);
  });

  it("shows version and build, without the desktop-only diagnostics in a browser", () => {
    renderPrefs();
    expect(screen.getByRole("heading", { name: /^Typewriter / })).toBeTruthy();
    expect(screen.getByTestId("build-id").textContent).toMatch(/^Build \S+/);
    expect(screen.queryByTestId("copy-diagnostics")).toBeNull();
  });

  describe("in the desktop app", () => {
    beforeEach(() => {
      (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    });

    it("copies typing diagnostics through the native command", async () => {
      invoke.mockResolvedValueOnce(undefined);
      renderPrefs();
      await userEvent.click(screen.getByTestId("copy-diagnostics"));
      expect(invoke).toHaveBeenCalledWith("copy_diagnostics");
      expect(toasts()).toEqual([["Typing diagnostics copied. They contain timings and window types, not your text.", "toast toast--success"]]);
    });

    it("reports a failure to copy diagnostics", async () => {
      invoke.mockRejectedValueOnce(new Error("clipboard busy"));
      renderPrefs();
      await userEvent.click(screen.getByRole("button", { name: "Copy typing diagnostics" }));
      expect(toasts()).toEqual([["Couldn't copy the diagnostics: Error: clipboard busy", "toast toast--error"]]);
    });
  });
});

describe("PreferencesView with live state", () => {
  it("reflects a toggled switch", async () => {
    function Live() {
      const [prefs, setPrefs] = useState({ ...DEFAULT_PREFS });
      const session = fakeSession({ prefs, updatePrefs: (p: Partial<typeof prefs>) => setPrefs((x) => ({ ...x, ...p })) } as Partial<Session>);
      return (
        <ToastProvider>
          <PreferencesView session={session} themePreference="system" onThemePreference={() => {}} />
        </ToastProvider>
      );
    }
    render(<Live />);
    const remember = screen.getByRole("switch", { name: "Remember my text on this device" });
    await userEvent.click(remember);
    expect(remember.getAttribute("aria-checked")).toBe("true");
  });
});
