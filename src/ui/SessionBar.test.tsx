// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExternalInfo, PlaybackSnapshot, PlaybackStatus } from "../engine";
import type { Session } from "../state/useSession";
import { copyText, SessionBar } from "./SessionBar";

// ExternalPanel has its own tests; here only its hand-off points matter.
vi.mock("./ExternalPanel", () => ({
  externalLabel: (ext: { phase: string }) => `label:${ext.phase}`,
  ExternalStatus: () => <div data-testid="external-status" />,
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type Opts = {
  status?: PlaybackStatus;
  snapshot?: Partial<PlaybackSnapshot>;
  elapsed?: number;
  canRestart?: boolean;
  over?: Partial<Session>;
};

function fakeSession({ status = "ready", snapshot, elapsed = 0, canRestart = true, over }: Opts = {}): Session {
  const snap: PlaybackSnapshot = {
    status,
    elapsedMs: 0,
    totalMs: 60_000,
    progress: 0,
    eventIndex: 0,
    eventCount: 100,
    sourceDone: 0,
    sourceTotal: 300,
    currentWpm: 0,
    recent: [],
    error: null,
    bufferRevision: 0,
    ...snapshot,
  };
  return {
    snapshot: snap,
    controller: { getElapsed: vi.fn(() => elapsed), canRestart },
    estimate: { totalMs: 90_000, effectiveWpm: 47.6 },
    blank: false,
    issues: [],
    destination: "preview",
    support: { available: false, state: "browser", platform: "web", message: "Typing into other apps needs the desktop app." },
    host: "web",
    stats: { characters: 300, charactersNoSpaces: 250, words: 50, lines: 1, paragraphs: 1 },
    settingsChangedSinceStart: false,
    start: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    restart: vi.fn(),
    ...over,
  } as unknown as Session;
}

function ext(phase: ExternalInfo["phase"], over: Partial<ExternalInfo> = {}): ExternalInfo {
  return {
    phase,
    countdownMs: 0,
    target: null,
    reason: null,
    message: null,
    verification: "not-run",
    verificationDetail: null,
    shortcutRegistered: true,
    ...over,
  };
}

function renderBar(opts: Opts = {}) {
  const session = fakeSession(opts);
  const onCopy = vi.fn();
  const utils = render(<SessionBar session={session} onCopy={onCopy} />);
  return { ...utils, session, onCopy };
}

const btn = (id: string) => screen.getByTestId(id) as HTMLButtonElement;
const metric = (label: string) => {
  const dt = [...document.querySelectorAll(".metric dt")].find((d) => d.textContent === label);
  return dt?.nextElementSibling?.textContent;
};
const announce = () => screen.getByTestId("announce").textContent;
const hint = () => document.querySelector(".session-bar__hint")?.textContent ?? null;

describe("copyText", () => {
  it("uses the async clipboard when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    expect(await copyText("hello")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("falls back to a hidden textarea when the clipboard API is blocked", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    let copied: string | null = null;
    const exec = vi.fn(() => {
      const ta = document.activeElement?.tagName === "TEXTAREA" ? (document.activeElement as HTMLTextAreaElement) : document.querySelector("textarea");
      copied = ta?.value ?? null;
      expect(ta?.readOnly).toBe(true);
      return true;
    });
    Object.defineProperty(document, "execCommand", { value: exec, configurable: true });
    expect(await copyText("tab\there")).toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
    expect(copied).toBe("tab\there");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("reports failure when the fallback copy throws", async () => {
    vi.stubGlobal("navigator", {});
    Object.defineProperty(document, "execCommand", {
      value: () => {
        throw new Error("nope");
      },
      configurable: true,
    });
    expect(await copyText("x")).toBe(false);
    expect(document.querySelector("textarea")).toBeNull();
  });
});

describe("SessionBar when ready", () => {
  it("shows the planned session and starts it", async () => {
    const { session } = renderBar();
    expect(screen.getByTestId("status").textContent).toBe("Ready");
    expect(screen.getByTestId("elapsed").textContent).toBe("0:00");
    expect(screen.getByTestId("remaining").textContent).toBe("1:30");
    expect(screen.getByTestId("progress-pct").textContent).toBe("0");
    const bar = screen.getByRole("progressbar", { name: "Playback progress" });
    expect(bar.getAttribute("aria-valuenow")).toBe("0");
    expect(bar.getAttribute("aria-valuetext")).toBe("0% · 0:00 of 1:30");
    expect(metric("Speed")).toBe("48 WPM avg");
    expect(metric("Typed")).toBe("0 / 300");
    expect(metric("Finishes")).toMatch(/^around /);
    expect(announce()).toBe("");
    expect(hint()).toBeNull();
    expect(btn("btn-restart").disabled).toBe(true);
    expect(btn("btn-stop").disabled).toBe(true);
    expect(btn("btn-copy").disabled).toBe(true);
    expect(btn("btn-copy").title).toBe("Available when typing is complete");
    const start = btn("btn-start");
    expect(start.textContent).toBe("Start");
    expect(start.title).toBe("Start (Ctrl + Enter)");
    await userEvent.click(start);
    expect(session.start).toHaveBeenCalled();
  });

  it("asks for text when the editor is blank", () => {
    renderBar({ status: "empty", over: { blank: true, estimate: { totalMs: 0, effectiveWpm: 0 } } as Partial<Session> });
    expect(btn("btn-start").disabled).toBe(true);
    expect(hint()).toBe("Add some text to start.");
    expect(metric("Finishes")).toBe("–");
    expect(screen.getByTestId("progress-pct").textContent).toBe("0");
  });

  it("explains a settings problem", () => {
    renderBar({ over: { issues: [{ field: "wpm", message: "Set a speed between 5 and 400 WPM." }] } as Partial<Session> });
    expect(btn("btn-start").disabled).toBe(true);
    expect(hint()).toBe("Set a speed between 5 and 400 WPM.");
  });

  it("reminds that the settings changed since the last run", () => {
    renderBar({ status: "stopped", over: { settingsChangedSinceStart: true } as Partial<Session> });
    expect(hint()).toBe("Settings changed. Restart to type with the new settings.");
  });
});

describe("SessionBar while typing", () => {
  it("ticks the elapsed time and offers pause, stop and restart", async () => {
    vi.useFakeTimers();
    let now = 15_000;
    const session = fakeSession({ status: "playing", snapshot: { totalMs: 60_000, currentWpm: 61.4, sourceDone: 75 } });
    (session.controller.getElapsed as ReturnType<typeof vi.fn>).mockImplementation(() => now);
    render(<SessionBar session={session} onCopy={() => {}} />);
    expect(screen.getByTestId("status").textContent).toBe("Typing");
    expect(screen.getByTestId("elapsed").textContent).toBe("0:15");
    expect(screen.getByTestId("remaining").textContent).toBe("0:45");
    expect(screen.getByTestId("progress-pct").textContent).toBe("25");
    expect(metric("Speed now")).toBe("61 WPM");
    expect(metric("Typed")).toBe("75 / 300");
    expect(metric("Finishes")).toMatch(/^around /);
    expect(announce()).toBe("Typing started.");
    expect(screen.getByRole("region", { name: "Playback controls and progress" }).className).toContain("is-playing");
    now = 30_000;
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByTestId("elapsed").textContent).toBe("0:30");
    expect(screen.getByTestId("progress-pct").textContent).toBe("50");
    now = 90_000; // past the planned end: progress caps at 100, nothing remains
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByTestId("progress-pct").textContent).toBe("100");
    expect(screen.getByTestId("remaining").textContent).toBe("0:00");

    fireEvent.click(btn("btn-pause"));
    expect(session.pause).toHaveBeenCalled();
    expect(btn("btn-pause").title).toBe("Pause (Space)");
    fireEvent.click(btn("btn-stop"));
    expect(session.stop).toHaveBeenCalled();
    expect(btn("btn-restart").title).toBe("Restart from the beginning");
    fireEvent.click(btn("btn-restart"));
    expect(session.restart).toHaveBeenCalled();
  });

  it("disables restart where replaying would duplicate text", () => {
    renderBar({ status: "playing", canRestart: false });
    expect(btn("btn-restart").disabled).toBe(true);
    expect(btn("btn-restart").title).toMatch(/^Not available when typing into another app/);
  });

  it("resumes from pause", async () => {
    const { session } = renderBar({ status: "paused", elapsed: 20_000, snapshot: { totalMs: 80_000, currentWpm: 0 } });
    expect(metric("Speed now")).toBe("0 WPM");
    expect(metric("Finishes")).toBe("paused");
    expect(announce()).toBe("Paused at 25 percent.");
    expect(btn("btn-stop").disabled).toBe(false);
    expect(btn("btn-restart").disabled).toBe(false);
    await userEvent.click(btn("btn-resume"));
    expect(session.resume).toHaveBeenCalled();
  });
});

describe("SessionBar after typing", () => {
  it("shows a full bar, offers to copy and start again", async () => {
    const { session, onCopy } = renderBar({ status: "completed", snapshot: { totalMs: 60_000, elapsedMs: 60_000, sourceDone: 300 } });
    expect(screen.getByTestId("elapsed").textContent).toBe("1:00");
    expect(screen.getByTestId("progress-pct").textContent).toBe("100");
    expect(metric("Speed")).toBe("60 WPM avg");
    expect(metric("Finishes")).toBe("done");
    expect(announce()).toBe("Typing complete. The output matches your text exactly.");
    const again = btn("btn-start");
    expect(again.textContent).toBe("Start again");
    await userEvent.click(again);
    expect(session.start).toHaveBeenCalled();
    const copy = btn("btn-copy");
    expect(copy.disabled).toBe(false);
    expect(copy.title).toBe("Copy your original text");
    await userEvent.click(copy);
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(copy.textContent).toBe("Copied");
  });

  it("returns the copy button to normal after a moment", () => {
    vi.useFakeTimers();
    renderBar({ status: "completed" });
    fireEvent.click(btn("btn-copy"));
    expect(btn("btn-copy").textContent).toBe("Copied");
    act(() => {
      vi.advanceTimersByTime(1800);
    });
    expect(btn("btn-copy").textContent).toBe("Copy text");
  });

  it("reports zero speed for a session with no elapsed time", () => {
    renderBar({ status: "completed", snapshot: { elapsedMs: 0, totalMs: 0 } });
    expect(metric("Speed")).toBe("0 WPM avg");
    expect(screen.getByTestId("progress-pct").textContent).toBe("100");
  });

  it("announces where a stopped session ended", () => {
    renderBar({ status: "stopped", elapsed: 6_000, snapshot: { totalMs: 60_000, elapsedMs: 6_000, sourceDone: 30 } });
    expect(announce()).toBe("Stopped at 10 percent.");
    expect(metric("Finishes")).toBe("–");
    expect(btn("btn-start").textContent).toBe("Start again");
    expect(btn("btn-stop").disabled).toBe(true);
    expect(btn("btn-restart").disabled).toBe(false);
  });

  it("announces a playback error", () => {
    renderBar({ status: "error", snapshot: { error: "The timeline could not be built." } });
    expect(announce()).toBe("The timeline could not be built.");
    expect(btn("btn-restart").disabled).toBe(true);
    cleanup();
    renderBar({ status: "error" });
    expect(announce()).toBe("Playback error.");
    expect(btn("btn-start").textContent).toBe("Start again");
  });
});

describe("SessionBar typing into another app", () => {
  const external = (over: Partial<Session> = {}) =>
    ({ destination: "external", support: { available: true, state: "ok", platform: "linux", message: "" }, ...over }) as Partial<Session>;

  it("offers to type into the chosen app", async () => {
    const { session } = renderBar({ over: external({ host: "desktop" }) });
    const start = btn("btn-start");
    expect(start.textContent).toBe("Type into app");
    await userEvent.click(start);
    expect(session.start).toHaveBeenCalled();
  });

  it("says page in the Chrome extension", () => {
    renderBar({ over: external({ host: "extension" }) });
    expect(btn("btn-start").textContent).toBe("Type into page");
  });

  it("explains why external typing is unavailable", () => {
    renderBar({ over: external({ support: { available: false, state: "browser", platform: "web", message: "Needs the desktop app." } } as Partial<Session>) });
    expect(btn("btn-start").disabled).toBe(true);
    expect(hint()).toBe("Needs the desktop app.");
  });

  it.each<[PlaybackStatus, ExternalInfo["phase"]]>([
    ["completed", "completed"],
    ["stopped", "stopped"],
    ["error", "failed"],
  ])("offers to type again when %s", (status, phase) => {
    renderBar({ status, snapshot: { external: ext(phase) }, over: external() });
    expect(btn("btn-start").textContent).toBe("Type again");
    expect(screen.getByTestId("status").textContent).toBe(`label:${phase}`);
    expect(screen.getByTestId("external-status")).toBeTruthy();
  });

  it.each<ExternalInfo["phase"]>(["preparing", "waiting", "countdown", "resuming"])("can cancel while %s", async (phase) => {
    const { session } = renderBar({ status: phase === "resuming" ? "paused" : "playing", snapshot: { external: ext(phase) }, over: external() });
    const cancel = btn("btn-cancel");
    expect(cancel.textContent).toBe("Cancel");
    expect(cancel.title).toBe("Cancel (Esc)");
    await userEvent.click(cancel);
    expect(session.stop).toHaveBeenCalled();
  });

  it("pauses while keys are going out", () => {
    renderBar({ status: "playing", snapshot: { external: ext("typing") }, over: external() });
    expect(btn("btn-pause").textContent).toBe("Pause");
  });

  it("distinguishes sent from verified when complete", () => {
    renderBar({ status: "completed", snapshot: { external: ext("completed", { verification: "sent" }) }, over: external() });
    expect(announce()).toBe("Every key was sent. The document text hasn't been verified.");
    cleanup();
    renderBar({ status: "completed", snapshot: { external: ext("completed", { verification: "verified" }) }, over: external() });
    expect(announce()).toBe("Typing complete and verified in your document.");
  });

  it("hides the external status while idle", () => {
    renderBar({ snapshot: { external: ext("idle") }, over: external() });
    expect(screen.queryByTestId("external-status")).toBeNull();
    expect(screen.getByTestId("status").textContent).toBe("label:idle");
  });
});
