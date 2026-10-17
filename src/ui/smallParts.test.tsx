// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlaybackSnapshot, PlaybackStatus } from "../engine";
import { ActivityLog } from "./ActivityLog";
import { Logo, LogoMark } from "./Logo";
import { StatusPill } from "./StatusPill";
import { ThemeSwitch } from "./ThemeSwitch";

afterEach(cleanup);

describe("Logo", () => {
  it("shows the mark with an accessible name and the word mark", () => {
    const { container } = render(<Logo />);
    const mark = screen.getByRole("img", { name: "Typewriter logo" });
    expect(mark.style.getPropertyValue("--logo-size")).toBe("44px");
    expect(mark.hasAttribute("aria-hidden")).toBe(false);
    expect(container.querySelector(".logo__word")?.textContent).toBe("typewriter");
  });

  it("drops the word mark and shrinks when compact", () => {
    const { container } = render(<Logo compact />);
    expect(screen.getByRole("img", { name: "Typewriter logo" }).style.getPropertyValue("--logo-size")).toBe("36px");
    expect(container.querySelector(".logo__word")).toBeNull();
  });

  it("is decorative without a title", () => {
    render(<LogoMark />);
    const mark = screen.getByTestId("logo-mark");
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    expect(mark.hasAttribute("role")).toBe(false);
    expect(mark.hasAttribute("aria-label")).toBe(false);
    expect(mark.style.getPropertyValue("--logo-size")).toBe("40px");
  });
});

describe("ThemeSwitch", () => {
  it("reports light mode and asks to switch to dark", async () => {
    const onToggle = vi.fn();
    render(<ThemeSwitch theme="light" onToggle={onToggle} />);
    const sw = screen.getByRole("switch", { name: "Dark mode" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(sw.getAttribute("title")).toBe("Switch to dark mode");
    expect(sw.className).not.toContain("is-dark");
    expect(sw.querySelector(".sr-only")?.textContent).toBe("Light");
    await userEvent.click(sw);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("reports dark mode", () => {
    render(<ThemeSwitch theme="dark" onToggle={() => {}} />);
    const sw = screen.getByRole("switch", { name: "Dark mode" });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(sw.getAttribute("title")).toBe("Switch to light mode");
    expect(sw.className).toContain("is-dark");
    expect(sw.querySelector(".sr-only")?.textContent).toBe("Dark");
  });
});

describe("StatusPill", () => {
  const cases: [PlaybackStatus, string][] = [
    ["empty", "No text"],
    ["ready", "Ready"],
    ["playing", "Typing"],
    ["paused", "Paused"],
    ["completed", "Complete"],
    ["stopped", "Stopped"],
    ["error", "Error"],
  ];
  it.each(cases)("shows %s with an icon and the word %s", (status, word) => {
    render(<StatusPill status={status} />);
    const pill = screen.getByTestId("status");
    expect(pill.textContent).toBe(word);
    expect(pill.className).toContain(`status-pill--${status}`);
    expect(pill.className).not.toContain("status-pill--compact");
    expect(pill.querySelector(".status-pill__icon svg")).not.toBeNull();
  });

  it("can override the label and be compact", () => {
    render(<StatusPill status="playing" compact label="Typing into Notes" />);
    const pill = screen.getByTestId("status");
    expect(pill.textContent).toBe("Typing into Notes");
    expect(pill.className).toContain("status-pill--compact");
  });
});

describe("ActivityLog", () => {
  const snap = (over: Partial<PlaybackSnapshot>): PlaybackSnapshot => ({
    status: "playing",
    elapsedMs: 0,
    totalMs: 10_000,
    progress: 0,
    eventIndex: 0,
    eventCount: 10,
    sourceDone: 0,
    sourceTotal: 10,
    currentWpm: 0,
    recent: [],
    error: null,
    bufferRevision: 0,
    ...over,
  });

  it("explains what will appear while nothing has happened yet", () => {
    render(<ActivityLog snapshot={snap({ status: "ready" })} />);
    expect(screen.getByLabelText("Recent typing events").textContent).toContain("Typos and their fixes show up here as they happen.");
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("says a completed take had no typos", () => {
    render(<ActivityLog snapshot={snap({ status: "completed" })} />);
    expect(screen.getByText("No typos in this take.")).toBeTruthy();
  });

  it("lists at most the four newest events, newest highlighted", () => {
    const recent = [
      { at: 65_000, note: "Fixed “teh”" },
      { at: 4_000, note: "Autocorrected “recieve”" },
      { at: 3_000, note: "Typo" },
      { at: 2_000, note: "Typo 2" },
      { at: 1_000, note: "Too old" },
    ];
    render(<ActivityLog snapshot={snap({ recent })} />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(4);
    expect(items[0].className).toBe("is-latest");
    expect(items[1].className).toBe("");
    expect(items[0].querySelector("time")?.textContent).toBe("1:05");
    expect(items[0].textContent).toContain("Fixed “teh”");
    expect(screen.queryByText("Too old")).toBeNull();
  });
});
