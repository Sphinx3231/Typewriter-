// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExternalInfo, PlaybackStatus } from "../engine";
import type { Host } from "../platform";
import type { Support } from "../desktop/bridge";
import type { VerifyResult } from "../desktop/verify";
import type { Session } from "../state/useSession";
import { ToastProvider } from "./controls";
import { DESKTOP_STOP_SHORTCUT, ExternalGuide, externalLabel, ExternalStatus, OutputSettings, useStopShortcut } from "./ExternalPanel";

const stopShortcut = vi.fn(async () => "Alt+Shift+S");
vi.mock("../extension/bridge", () => ({ stopShortcut: () => stopShortcut() }));

const IDLE: ExternalInfo = {
  phase: "idle",
  countdownMs: 0,
  target: null,
  reason: null,
  message: null,
  verification: "not-run",
  verificationDetail: null,
  shortcutRegistered: true,
};

const ext = (p: Partial<ExternalInfo>): ExternalInfo => ({ ...IDLE, ...p });

interface FakeOpts {
  host?: Host;
  external?: Partial<ExternalInfo>;
  status?: PlaybackStatus;
  destination?: "preview" | "external";
  support?: Partial<Support>;
  countdownSec?: number;
  minimizeWhileTyping?: boolean;
  verify?: () => Promise<VerifyResult | null>;
}

/** Only the parts of a session these components read. */
function fakeSession(o: FakeOpts = {}) {
  const s = {
    host: o.host ?? "desktop",
    snapshot: { status: o.status ?? "playing", external: o.external ? ext(o.external) : undefined },
    destination: o.destination ?? "external",
    setDestination: vi.fn(),
    support: { available: true, state: "ok", platform: "linux", message: "Ready to type into other apps.", ...o.support },
    refreshSupport: vi.fn(async () => {}),
    prefs: { countdownSec: o.countdownSec ?? 5, minimizeWhileTyping: o.minimizeWhileTyping ?? true },
    updatePrefs: vi.fn(),
    verifyDestination: vi.fn(o.verify ?? (async () => null)),
  };
  return s as typeof s & Session;
}

function show(node: JSX.Element) {
  return render(<ToastProvider>{node}</ToastProvider>);
}

const statusText = () => screen.getByTestId("ext-status").textContent ?? "";

afterEach(() => {
  cleanup();
  stopShortcut.mockReset();
  stopShortcut.mockImplementation(async () => "Alt+Shift+S");
});

describe("externalLabel", () => {
  it("names every phase in plain words", () => {
    expect(externalLabel(ext({ phase: "preparing" }))).toBe("Getting ready");
    expect(externalLabel(ext({ phase: "waiting" }))).toBe("Switch to your document");
    expect(externalLabel(ext({ phase: "countdown", countdownMs: 2100 }))).toBe("Starting in 3");
    expect(externalLabel(ext({ phase: "countdown", countdownMs: 0 }))).toBe("Starting in 1");
    expect(externalLabel(ext({ phase: "typing", target: { title: "Doc", appName: "Chrome" } }))).toBe("Typing into Chrome");
    expect(externalLabel(ext({ phase: "typing", target: { title: "Doc", appName: "" } }))).toBe("Typing into app");
    expect(externalLabel(ext({ phase: "typing" }))).toBe("Typing");
    expect(externalLabel(ext({ phase: "paused" }))).toBe("Paused");
    expect(externalLabel(ext({ phase: "resuming", countdownMs: 1500 }))).toBe("Resuming in 2");
    expect(externalLabel(ext({ phase: "resuming", countdownMs: 0 }))).toBe("Click back into your document");
    expect(externalLabel(ext({ phase: "completed", verification: "verified" }))).toBe("Verified");
    expect(externalLabel(ext({ phase: "completed", verification: "sent" }))).toBe("Sent");
    expect(externalLabel(ext({ phase: "failed" }))).toBe("Couldn't type");
    expect(externalLabel(ext({ phase: "stopped" }))).toBeUndefined();
    expect(externalLabel(ext({ phase: "idle" }))).toBeUndefined();
  });
});

describe("useStopShortcut", () => {
  it("uses the fixed desktop shortcut and the default Chrome one outside the extension", () => {
    expect(renderHook(() => useStopShortcut("desktop")).result.current).toBe(DESKTOP_STOP_SHORTCUT);
    expect(renderHook(() => useStopShortcut("web")).result.current).toBe("Alt+Shift+Period");
    expect(stopShortcut).not.toHaveBeenCalled();
  });

  it("reads the shortcut Chrome actually assigned, and says when none is set", async () => {
    const a = renderHook(() => useStopShortcut("extension"));
    await waitFor(() => expect(a.result.current).toBe("Alt+Shift+S"));
    stopShortcut.mockImplementation(async () => "");
    const b = renderHook(() => useStopShortcut("extension"));
    await waitFor(() => expect(b.result.current).toBe("not set (chrome://extensions/shortcuts)"));
  });
});

describe("ExternalStatus", () => {
  it("explains the preparing step, with the engine's message or a default", () => {
    show(<ExternalStatus session={fakeSession({ external: { phase: "preparing", message: "Loading keyboard…" } })} />);
    expect(screen.getByTestId("ext-preparing").textContent).toContain("Loading keyboard… Nothing is typed yet.");
    cleanup();
    show(<ExternalStatus session={fakeSession({ external: { phase: "preparing" } })} />);
    expect(screen.getByTestId("ext-preparing").textContent).toContain("Getting the keyboard ready…");
    expect(screen.getByTestId("ext-status").dataset.phase).toBe("preparing");
  });

  it("tells the user where to click while waiting, on desktop and in Chrome", () => {
    show(<ExternalStatus session={fakeSession({ external: { phase: "waiting" } })} />);
    expect(statusText()).toContain("Switch to your document and click exactly where the text should start.");
    cleanup();
    show(<ExternalStatus session={fakeSession({ external: { phase: "waiting", message: "Pick a window." } })} />);
    expect(statusText()).toContain("Pick a window. Nothing is typed yet.");
    cleanup();
    show(<ExternalStatus session={fakeSession({ host: "extension", external: { phase: "waiting" } })} />);
    expect(statusText()).toContain("Switch to the tab you want to type into.");
    cleanup();
    show(<ExternalStatus session={fakeSession({ host: "extension", external: { phase: "waiting", message: "Open a tab." } })} />);
    expect(statusText()).toContain("Open a tab.");
  });

  it("shows the countdown and warns when the emergency shortcut is missing", () => {
    show(<ExternalStatus session={fakeSession({ external: { phase: "countdown", countdownMs: 2500, shortcutRegistered: false } })} />);
    expect(screen.getByTestId("ext-countdown").textContent).toContain("Typing starts in 3.");
    expect(statusText()).toContain("Keep the cursor where you want the text.");
    expect(statusText()).toContain("The emergency shortcut couldn't be registered on this system.");
    cleanup();
    show(<ExternalStatus session={fakeSession({ host: "extension", external: { phase: "countdown", countdownMs: 0, shortcutRegistered: false } })} />);
    expect(screen.getByTestId("ext-countdown").textContent).toContain("Typing starts in 1.");
    expect(statusText()).toContain("Click in the page exactly where the text should start.");
    expect(statusText()).toContain("No keyboard shortcut is set for Stop typing");
  });

  it("names the target and the emergency stop while typing", async () => {
    show(
      <ExternalStatus
        session={fakeSession({ external: { phase: "typing", target: { title: "Essay.docx", appName: "Word" }, message: "Typing slowly." } })}
      />,
    );
    expect(statusText()).toContain("Typing into Essay.docx.");
    expect(statusText()).toContain("Typing slowly.");
    expect(statusText()).toContain(DESKTOP_STOP_SHORTCUT);
    expect(statusText()).toContain("move the mouse to the top-left corner");
    // The shortcut warning only appears when it is not registered.
    expect(statusText()).not.toContain("couldn't be registered");
    cleanup();
    show(<ExternalStatus session={fakeSession({ host: "extension", external: { phase: "typing", message: "ignored in Chrome" } })} />);
    expect(statusText()).toContain("Typing into the selected window.");
    expect(statusText()).not.toContain("ignored in Chrome");
    expect(statusText()).toContain("Closing this panel or Chrome's debugging bar also stops it.");
    await waitFor(() => expect(statusText()).toContain("Alt+Shift+S"));
  });

  it("explains pause and resume", () => {
    show(<ExternalStatus session={fakeSession({ status: "paused", external: { phase: "paused", message: "You clicked another window." } })} />);
    expect(statusText()).toContain("You clicked another window. Press Resume, then click back into your document.");
    cleanup();
    show(<ExternalStatus session={fakeSession({ host: "extension", status: "paused", external: { phase: "paused" } })} />);
    expect(statusText()).toContain("Paused. Press Resume, then go back to the tab.");
    cleanup();
    show(<ExternalStatus session={fakeSession({ status: "paused", external: { phase: "resuming" } })} />);
    expect(statusText().trim()).toBe("Paused.");
  });

  it("explains why typing stopped or failed", () => {
    show(<ExternalStatus session={fakeSession({ status: "stopped", external: { phase: "stopped", reason: "failsafe" } })} />);
    expect(statusText()).toBe("Stopped because the mouse moved to the top-left corner.");
    cleanup();
    show(<ExternalStatus session={fakeSession({ status: "stopped", external: { phase: "stopped", message: "Stopped before typing began." } })} />);
    expect(statusText()).toBe("Stopped before typing began.");
    cleanup();
    show(<ExternalStatus session={fakeSession({ status: "stopped", external: { phase: "stopped" } })} />);
    expect(statusText()).toBe("Stopped. Keys already typed stay in your document.");
    cleanup();
    show(<ExternalStatus session={fakeSession({ status: "error", external: { phase: "failed", message: "No display." } })} />);
    expect(screen.getByRole("alert").textContent).toContain("No display.");
    cleanup();
    show(<ExternalStatus session={fakeSession({ status: "error", external: { phase: "failed" } })} />);
    expect(screen.getByRole("alert").textContent).toContain("Typing into the other app failed.");
    cleanup();
    show(<ExternalStatus session={fakeSession({ status: "ready", external: { phase: "idle" } })} />);
    expect(statusText()).toBe("");
  });

  it("shows a verified result without a check button", () => {
    show(<ExternalStatus session={fakeSession({ status: "completed", external: { phase: "completed", verification: "verified", verificationDetail: "Exact match." } })} />);
    expect(screen.getByTestId("ext-verified").textContent).toContain("Exact match.");
    expect(screen.queryByTestId("btn-verify")).toBeNull();
  });

  it("asks the user to check the document, and reports an empty clipboard", async () => {
    let release: (r: VerifyResult) => void = () => {};
    const verify = () => new Promise<VerifyResult>((r) => (release = r));
    const s = fakeSession({ status: "completed", external: { phase: "completed", verification: "sent" }, verify });
    show(<ExternalStatus session={s} />);
    expect(screen.getByTestId("ext-unverified").textContent).toContain("Typewriter can't see inside other apps.");
    const btn = screen.getByTestId("btn-verify") as HTMLButtonElement;
    act(() => void fireEvent.click(btn));
    expect(btn.textContent).toBe("Checking…");
    expect(btn.disabled).toBe(true);
    await act(async () => release({ status: "empty", detail: "The clipboard is empty." }));
    expect(s.verifyDestination).toHaveBeenCalledTimes(1);
    expect(btn.textContent).toBe("Check copied text");
    expect(screen.getByText("The clipboard is empty.")).toBeTruthy();
  });

  it("shows a mismatch, and does not toast when a check gives a result", async () => {
    const s = fakeSession({
      status: "completed",
      external: { phase: "completed", verification: "mismatch", verificationDetail: "First difference at character 3." },
      verify: async () => ({ status: "mismatch", detail: "First difference at character 3." }),
    });
    show(<ExternalStatus session={s} />);
    expect(screen.getByTestId("ext-unverified").textContent).toContain("The document text doesn't match. First difference at character 3.");
    await act(async () => void fireEvent.click(screen.getByTestId("btn-verify")));
    expect(document.querySelectorAll(".toast")).toHaveLength(0);
    cleanup();
    // A detail from the destination replaces the generic explanation.
    const t = fakeSession({ status: "completed", external: { phase: "completed", verification: "sent", verificationDetail: "Read back 10 characters." } });
    show(<ExternalStatus session={t} />);
    expect(screen.getByTestId("ext-unverified").textContent).toContain("Read back 10 characters.");
    await act(async () => void fireEvent.click(screen.getByTestId("btn-verify")));
    expect(t.verifyDestination).toHaveBeenCalled();
    expect(document.querySelectorAll(".toast")).toHaveLength(0);
  });
});

describe("ExternalGuide", () => {
  it("lists the desktop steps with the countdown and whether Typewriter minimises", () => {
    show(<ExternalGuide session={fakeSession({ countdownSec: 7 })} />);
    const g = screen.getByTestId("ext-guide").textContent;
    expect(g).toContain("Type into another app");
    expect(g).toContain("Typewriter minimises itself");
    expect(g).toContain("After a 7-second countdown");
    expect(g).toContain(DESKTOP_STOP_SHORTCUT);
    cleanup();
    show(<ExternalGuide session={fakeSession({ minimizeWhileTyping: false })} />);
    expect(screen.getByTestId("ext-guide").textContent).toContain("Typewriter steps aside");
  });

  it("lists the Chrome steps with the real stop shortcut", async () => {
    show(<ExternalGuide session={fakeSession({ host: "extension", countdownSec: 3 })} />);
    const g = () => screen.getByTestId("ext-guide").textContent;
    expect(g()).toContain("Type into a web page");
    expect(g()).toContain("After a 3-second countdown");
    await waitFor(() => expect(g()).toContain("Alt+Shift+S"));
  });
});

describe("OutputSettings", () => {
  it("explains that the web build only previews", () => {
    show(<OutputSettings session={fakeSession({ host: "web" })} />);
    expect(screen.getByText(/This preview types inside Typewriter/)).toBeTruthy();
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });

  it("switches the destination and hides the external options for the preview", () => {
    const s = fakeSession({ destination: "preview", status: "ready" });
    show(<OutputSettings session={s} />);
    expect(screen.queryByTestId("ext-support")).toBeNull();
    expect(screen.queryByText("Change this after the current session ends.")).toBeNull();
    act(() => void fireEvent.click(screen.getByRole("radio", { name: "Into another app" })));
    expect(s.setDestination).toHaveBeenCalledWith("external");
  });

  it("shows support, the countdown and the minimise switch on desktop", () => {
    const s = fakeSession({ status: "ready" });
    show(<OutputSettings session={s} />);
    const support = screen.getByTestId("ext-support");
    expect(support.className).toContain("permission--ok");
    expect(support.textContent).toContain("Ready to type into other apps.");
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
    expect(screen.queryByTestId("permission-explainer")).toBeNull();

    const countdown = screen.getByLabelText("Countdown before typing") as HTMLInputElement;
    expect(screen.getByText("Time to click into your document after leaving Typewriter.")).toBeTruthy();
    fireEvent.focus(countdown);
    fireEvent.change(countdown, { target: { value: "12" } });
    fireEvent.blur(countdown);
    expect(s.updatePrefs).toHaveBeenCalledWith({ countdownSec: 12 });

    act(() => void fireEvent.click(screen.getByRole("switch", { name: "Minimise Typewriter while typing" })));
    expect(s.updatePrefs).toHaveBeenCalledWith({ minimizeWhileTyping: false });
  });

  it("offers to grant access when the OS denied it, and to check again", () => {
    const s = fakeSession({ status: "ready", support: { available: false, state: "permission-denied", platform: "macos", message: "Accessibility access needed." } });
    show(<OutputSettings session={s} />);
    expect(screen.getByTestId("ext-support").className).toContain("permission--no");
    act(() => void fireEvent.click(screen.getByRole("button", { name: "Grant access" })));
    expect(s.refreshSupport).toHaveBeenCalledWith(true);
    act(() => void fireEvent.click(screen.getByRole("button", { name: "Check again" })));
    expect(s.refreshSupport).toHaveBeenCalledWith(false);
  });

  it("only offers Check again for other problems", () => {
    show(<OutputSettings session={fakeSession({ status: "ready", support: { available: false, state: "wayland", message: "Wayland is not supported." } })} />);
    expect(screen.queryByRole("button", { name: "Grant access" })).toBeNull();
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
  });

  it("explains the debugger permission in Chrome and locks the choice while running", () => {
    const s = fakeSession({ host: "extension", status: "playing", support: { available: false, state: "permission-denied", platform: "chrome", message: "Allow debugging." } });
    show(<OutputSettings session={s} />);
    expect(screen.getByRole("radio", { name: "Into a web page" })).toBeTruthy();
    expect(screen.getByText("Change this after the current session ends.")).toBeTruthy();
    expect(screen.getByTestId("permission-explainer").textContent).toContain("Chrome's debugger permission");
    expect(screen.getByText("Time to click the insertion point in the page.")).toBeTruthy();
    // Chrome grants the permission through its own prompt, not a Grant button.
    expect(screen.queryByRole("button", { name: "Grant access" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Minimise Typewriter while typing" })).toBeNull();
    cleanup();
    show(<OutputSettings session={fakeSession({ host: "extension", status: "paused" })} />);
    expect(screen.getByText("Change this after the current session ends.")).toBeTruthy();
  });
});
