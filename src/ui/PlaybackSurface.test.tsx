// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildScript, buildTimeline, DEFAULT_SETTINGS, PlaybackController, type ExternalInfo, type PlaybackSettings, type PlaybackSnapshot } from "../engine";
import { FakeClock } from "../engine/testing";
import { PlaybackSurface } from "./PlaybackSurface";

const TEXT = "I recieve teh mail every morning, and then I read it carefully before breakfast. Their weather was quite nice.";

function timelineFor(text: string, patch: Partial<PlaybackSettings> = {}) {
  const s: PlaybackSettings = { ...DEFAULT_SETTINGS, timingMode: "speed", wpm: 60, ...patch };
  return buildTimeline(buildScript(text, s), s);
}

/** Wires a controller to the surface the way the app does. */
function Harness({ controller, guide, blank = false, override }: { controller: PlaybackController; guide?: JSX.Element; blank?: boolean; override?: Partial<PlaybackSnapshot> }) {
  const snap = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  return <PlaybackSurface controller={controller} snapshot={{ ...snap, ...override }} estimateMs={90_000} words={1} blank={blank} guide={guide} />;
}

const out = () => screen.getByTestId("playback-text");
const caret = () => out().querySelector(".caret") as HTMLElement | null;
const scroller = () => screen.getByRole("region", { name: "Typed output" });

let clock: FakeClock;
const tick = (ms: number) => act(() => clock.advance(ms));

beforeEach(() => {
  vi.useFakeTimers();
  clock = new FakeClock();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("PlaybackSurface empty states", () => {
  it("invites the user to add text when the editor is blank", () => {
    render(<Harness controller={new PlaybackController(clock)} blank guide={<p>guide</p>} />);
    expect(screen.getByText("Your text will be typed here")).toBeTruthy();
    // The guide is only shown once there is something to type.
    expect(screen.queryByText("guide")).toBeNull();
    expect(out().getAttribute("aria-hidden")).toBe("true");
  });

  it("shows the word count and estimate when ready", () => {
    const c = new PlaybackController(clock);
    c.load("Hello", timelineFor("Hello"));
    render(<Harness controller={c} />);
    expect(screen.getByText("Ready to type 1 word")).toBeTruthy();
    expect(screen.getByText(/it will take about/).textContent).toContain("Ctrl + Enter");
  });

  it("pluralises the word count", () => {
    const c = new PlaybackController(clock);
    render(<PlaybackSurface controller={c} snapshot={c.getSnapshot()} estimateMs={1000} words={1234} blank={false} />);
    expect(screen.getByText("Ready to type 1,234 words")).toBeTruthy();
  });

  it("shows the guide instead when one is given and there is text", () => {
    const c = new PlaybackController(clock);
    c.load("Hello", timelineFor("Hello"));
    render(<Harness controller={c} guide={<p>Type into another app</p>} />);
    expect(screen.getByText("Type into another app")).toBeTruthy();
    expect(screen.queryByText(/Ready to type/)).toBeNull();
  });
});

describe("PlaybackSurface playback", () => {
  it("shows typos while they are pending, highlights corrections, and ends with the exact text", () => {
    // A text and seed whose plan includes both backspaced typos and autocorrected words.
    const long = Array.from({ length: 8 }, () => TEXT).join(" ");
    let tl = timelineFor(long, { mistakes: "medium", correction: "mixed", seed: 1, wpm: 200 });
    for (let seed = 2; seed < 500; seed++) {
      const kinds = new Set(tl.events.map((e) => e.kind));
      if (kinds.has("replace") && kinds.has("backspace")) break;
      tl = timelineFor(long, { mistakes: "medium", correction: "mixed", seed, wpm: 200 });
    }
    const c = new PlaybackController(clock);
    c.load(long, tl);
    render(<Harness controller={c} />);
    act(() => void c.start());
    expect(out().getAttribute("aria-hidden")).toBe("false");
    expect(caret()?.classList.contains("is-typing")).toBe(true);

    let sawTypo = false;
    let sawFix = false;
    for (let i = 0; i < 10_000 && c.getStatus() === "playing"; i++) {
      tick(25);
      if (out().querySelector(".typo")) sawTypo = true;
      if (out().querySelector(".fixed")) sawFix = true;
    }
    expect(c.getStatus()).toBe("completed");
    expect(sawTypo).toBe(true);
    expect(sawFix).toBe(true);
    expect(out().textContent).toBe(long);
    expect(screen.getByTestId("verified-badge").textContent).toContain("Complete · matches your text exactly");

    // The correction highlight fades even without new keystrokes.
    tick(2000);
    act(() => void vi.advanceTimersByTime(300));
    expect(out().querySelector(".fixed")).toBeNull();
    expect(out().textContent).toBe(long);
    // Once nothing is landing, the caret goes back to blinking and stays that way (a session
    // with a correction used to keep it solid for good, redrawing every 300 ms).
    act(() => void vi.advanceTimersByTime(1000));
    expect(caret()?.classList.contains("is-typing")).toBe(false);
    act(() => void vi.advanceTimersByTime(3000));
    expect(caret()?.classList.contains("is-typing")).toBe(false);
  });

  it("rebuilds the output from scratch when playback restarts", () => {
    const c = new PlaybackController(clock);
    c.load("Plain words only.", timelineFor("Plain words only.", { mistakes: "off" }));
    render(<Harness controller={c} />);
    act(() => void c.start());
    tick(2000);
    const partial = out().textContent!;
    expect(partial.length).toBeGreaterThan(3);
    act(() => void c.restart());
    expect(out().textContent).toBe("");
    tick(60_000);
    expect(out().textContent).toBe("Plain words only.");
    // The caret stops looking busy once keys stop landing.
    expect(caret()?.classList.contains("is-typing")).toBe(true);
    act(() => void vi.advanceTimersByTime(500));
    expect(caret()?.classList.contains("is-typing")).toBe(false);
  });

  it("ignores a correction highlight that points outside the loaded timeline", () => {
    const c = new PlaybackController(clock);
    c.load("ab", timelineFor("ab", { mistakes: "off" }));
    render(<Harness controller={c} />);
    act(() => {
      c.buffer.apply({ kind: "type", text: "a", fix: true, note: "Corrected", u: 1, p: 0, ms: 0, src: 1 }, 99);
      c.refresh();
    });
    expect(c.buffer.lastFix?.eventIndex).toBe(99);
    expect(out().textContent).toBe("a");
    expect(out().querySelector(".fixed")).toBeNull();
  });

  it("shows paused and stopped badges", () => {
    const c = new PlaybackController(clock);
    c.load(TEXT, timelineFor(TEXT, { mistakes: "off" }));
    render(<Harness controller={c} />);
    act(() => void c.start());
    tick(3000);
    act(() => void c.pause());
    expect(screen.getByRole("status").textContent).toMatch(/Paused at 0:0\d/);
    act(() => void c.stop());
    expect(screen.getByRole("status").textContent).toMatch(/Stopped at \d+%/);
  });
});

describe("PlaybackSurface scrolling", () => {
  let caretTop = 0;
  beforeEach(() => {
    caretTop = 0;
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("caret") ? caretTop : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("caret") ? 20 : 0;
    });
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(200);
  });

  it("keeps the caret in view, lets the reader scroll away, and jumps back on request", () => {
    const c = new PlaybackController(clock);
    c.load(TEXT, timelineFor(TEXT, { mistakes: "off" }));
    render(<Harness controller={c} />);
    act(() => void c.start());
    const sc = scroller();

    // The caret moves below the visible area: the view follows it.
    caretTop = 1000;
    tick(1000);
    expect(sc.scrollTop).toBe(1000 + 20 + 50 - 200);
    // That programmatic scroll does not count as the reader scrolling away.
    fireEvent.scroll(sc);
    expect(screen.queryByText("Follow the caret")).toBeNull();

    // The caret moves above the visible area: the view follows it up.
    caretTop = 100;
    tick(1000);
    expect(sc.scrollTop).toBe(50);
    fireEvent.scroll(sc);

    // The reader scrolls to where the caret is still visible: nothing changes.
    sc.scrollTop = 60;
    fireEvent.scroll(sc);
    expect(screen.queryByText("Follow the caret")).toBeNull();

    // The reader scrolls far away: following stops and a jump button appears.
    sc.scrollTop = 900;
    fireEvent.scroll(sc);
    const jump = screen.getByText("Follow the caret");
    caretTop = 1200;
    tick(1000);
    expect(sc.scrollTop).toBe(900);

    act(() => void fireEvent.click(jump));
    expect(sc.scrollTop).toBe(1200 - 100);
    expect(screen.queryByText("Follow the caret")).toBeNull();
    fireEvent.scroll(sc);
    // Following again.
    caretTop = 2000;
    tick(1000);
    expect(sc.scrollTop).toBe(2000 + 20 + 50 - 200);
  });

  it("hides the jump button when the session ends, and resets following for the next text", () => {
    const c = new PlaybackController(clock);
    c.load(TEXT, timelineFor(TEXT, { mistakes: "off" }));
    render(<Harness controller={c} />);
    act(() => void c.start());
    tick(500);
    const sc = scroller();
    sc.scrollTop = 900;
    fireEvent.scroll(sc);
    expect(screen.getByText("Follow the caret")).toBeTruthy();
    act(() => void c.stop());
    expect(screen.queryByText("Follow the caret")).toBeNull();
    act(() => void c.load("New", timelineFor("New")));
    act(() => void c.start());
    caretTop = 1000;
    tick(1000);
    expect(sc.scrollTop).toBe(870);
  });

  it("uses a default line height when the caret has no measured height", () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(0);
    const c = new PlaybackController(clock);
    c.load(TEXT, timelineFor(TEXT, { mistakes: "off" }));
    render(<Harness controller={c} />);
    act(() => void c.start());
    caretTop = 1000;
    tick(500);
    expect(scroller().scrollTop).toBe(1000 + 24 + 60 - 200);
  });
});

describe("PlaybackSurface external results", () => {
  const info = (p: Partial<ExternalInfo>): ExternalInfo => ({
    phase: "completed",
    countdownMs: 0,
    target: null,
    reason: null,
    message: null,
    verification: "sent",
    verificationDetail: null,
    shortcutRegistered: true,
    ...p,
  });

  it("says keys were sent but the document is unchecked, until it is verified", () => {
    const c = new PlaybackController(clock);
    c.load("Hi", timelineFor("Hi"));
    const { rerender } = render(<Harness controller={c} override={{ status: "completed", eventIndex: 2, external: info({}) }} />);
    expect(screen.getByTestId("sent-badge").textContent).toContain("All keys sent · document not checked yet");
    expect(screen.queryByTestId("verified-badge")).toBeNull();
    rerender(<Harness controller={c} override={{ status: "completed", eventIndex: 2, external: info({ verification: "verified" }) }} />);
    expect(screen.getByRole("status").textContent).toContain("Verified in your document");
    expect(screen.queryByTestId("sent-badge")).toBeNull();
  });

  it("shows an error only when there is a message", () => {
    const c = new PlaybackController(clock);
    const { rerender } = render(<Harness controller={c} override={{ status: "error", error: "The typing engine stopped." }} />);
    expect(screen.getByRole("alert").textContent).toContain("The typing engine stopped.");
    rerender(<Harness controller={c} override={{ status: "error", error: null }} />);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
