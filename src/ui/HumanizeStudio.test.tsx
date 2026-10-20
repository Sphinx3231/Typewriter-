// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { humanize } from "../humanize";
import { diffText } from "../humanize/diff";
import { NATURAL, ROBOTIC, ROBOTIC_HUMANIZED } from "../humanize/fixtures";
import { useSession, type Session } from "../state/useSession";
import { HumanizeStatus } from "./HumanizeStatus";
import { HumanizeStudio, StudioPanel } from "./HumanizeStudio";

const FAST = { timingMode: "speed", wpm: 400, rhythm: false, pauses: false, mistakes: "off", sound: false };
let latest: Session;
function Live() {
  latest = useSession();
  return (
    <>
      <HumanizeStatus session={latest} />
      <StudioPanel session={latest} />
    </>
  );
}
function setup(text = ROBOTIC) {
  localStorage.setItem("typewriter:settings", JSON.stringify(FAST));
  localStorage.setItem("typewriter:prefs", JSON.stringify({ smartHumanize: true }));
  render(<Live />);
  act(() => latest.setText(text));
  return () => latest;
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const MIXED = ROBOTIC_HUMANIZED.replace("students use", "students utilize");
const changeButtons = (root: HTMLElement = screen.getByTestId("studio")) => [...root.querySelectorAll<HTMLButtonElement>("button[data-change]")];
const textOf = (id: string) => screen.getByTestId(id).textContent;
const highlightsOff = () => fireEvent.click(screen.getByTestId("studio-highlight"));
const pos = () => textOf("studio-pos");

describe("Humanization Studio", () => {
  it("shows the final text with each change highlighted and labelled, and a summary counted from the diff", () => {
    setup();
    expect(textOf("studio-summary")).toBe("9 changes · 26 words changed · 5 sentences adjusted (26 removed, 7 added)");
    const marks = changeButtons();
    expect(marks).toHaveLength(9);
    expect(marks.map((b) => b.getAttribute("aria-label"))).toContain("Reworded: “utilize” to “use”.");
    expect(marks.map((b) => b.getAttribute("aria-label"))).toContain("Removed “in order␣”.");
    // Only the changed words are highlighted, not the paragraph.
    const util = marks.find((b) => b.getAttribute("aria-label")!.includes("utilize"))!;
    expect(util.textContent).toBe("use");
    expect(util.querySelector("ins")).not.toBeNull();
    expect(util.className).toContain("chg--add");
    const gone = marks.find((b) => b.getAttribute("aria-label")!.startsWith("Removed"))!;
    expect(gone.className).toContain("chg--gone");
    expect(screen.getByText(/underlined/).closest(".studio__legend")).not.toBeNull();
    highlightsOff();
    expect(textOf("studio-revised-text")).toBe(ROBOTIC_HUMANIZED);
    expect(changeButtons()).toHaveLength(0);
    expect(pos()).toBe("Highlights off");
    expect((screen.getByTestId("studio-next") as HTMLButtonElement).disabled).toBe(true);
  });

  it("three synchronized views: final, side by side, original", async () => {
    setup();
    await userEvent.click(screen.getByRole("radio", { name: /Side by side/ }));
    expect(screen.getAllByTestId("studio-original-text")).toHaveLength(1);
    const left = screen.getByTestId("studio-original-text");
    const right = screen.getByTestId("studio-revised-text");
    expect([...left.querySelectorAll("del")].map((d) => d.textContent)).toEqual([
      "In today's fast-paced world, technology",
      "utilize",
      "in order ",
      "Furthermore, teachers",
      "numerous",
      "in order ",
      "Additionally, it is important to note that schools",
      "commence",
      "In conclusion, technology",
    ]);
    expect(right.querySelectorAll("ins")).toHaveLength(7);

    // Select a change in one view; it stays selected in the others.
    await userEvent.click(screen.getByTestId("studio-next"));
    await userEvent.click(screen.getByTestId("studio-next"));
    expect(pos()).toBe("Change 2 of 9");
    const selected = () => [...screen.getByTestId("studio").querySelectorAll(".is-selected")].map((e) => (e as HTMLElement).dataset.change);
    expect(selected()).toEqual(["1", "1"]);
    await userEvent.click(screen.getByRole("radio", { name: /Original/ }));
    expect(selected()).toEqual(["1"]);
    expect(screen.getByTestId("studio-original-text").querySelector(".is-selected")!.textContent).toBe("utilize");
    highlightsOff();
    expect(textOf("studio-original-text")).toBe(ROBOTIC);
    fireEvent.click(screen.getByTestId("studio-highlight"));
    await userEvent.click(screen.getByRole("radio", { name: /Final text/ }));
    expect(selected()).toEqual(["1"]);
  });

  it("previous/next walk the changes, with keyboard shortcuts, and each selection explains itself honestly", async () => {
    setup();
    expect(pos()).toBe("9 changes");
    expect(screen.queryByTestId("studio-explain")).toBeNull();
    await userEvent.click(screen.getByTestId("studio-next"));
    expect(pos()).toBe("Change 1 of 9");
    expect(textOf("studio-reason")).toBe("Removed a stock opening phrase, and capitalized the next word.");
    expect(screen.getByTestId("studio-explain").textContent).toContain("In today's fast-paced world, technology → Technology");
    expect((screen.getByTestId("studio-prev") as HTMLButtonElement).disabled).toBe(true);
    for (let i = 0; i < 8; i++) fireEvent.keyDown(screen.getByTestId("studio"), { key: "ArrowDown", altKey: true });
    expect(pos()).toBe("Change 9 of 9");
    expect((screen.getByTestId("studio-next") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(screen.getByTestId("studio"), { key: "ArrowUp", altKey: true });
    expect(pos()).toBe("Change 8 of 9");
    expect(textOf("studio-reason")).toBe("Simplified an unnecessarily formal expression.");
    // Other keys do nothing.
    fireEvent.keyDown(screen.getByTestId("studio"), { key: "ArrowUp" });
    expect(pos()).toBe("Change 8 of 9");
    await userEvent.click(screen.getByRole("button", { name: "Close explanation" }));
    expect(screen.queryByTestId("studio-explain")).toBeNull();
    // From nothing selected, "previous" starts at the last change.
    await userEvent.click(screen.getByTestId("studio-prev"));
    expect(pos()).toBe("Change 9 of 9");
    // Clicking a highlight selects it.
    await userEvent.click(changeButtons().find((b) => b.textContent === "use")!);
    expect(pos()).toBe("Change 2 of 9");
    expect(screen.getByTestId("studio-explain").textContent).toContain("utilize → use");
    // Clicking plain text keeps the selection.
    fireEvent.click(screen.getByTestId("studio-revised-text"));
    expect(pos()).toBe("Change 2 of 9");
  });

  it("per-change revert: keeps the original wording in exactly what will be typed, and can be undone", async () => {
    const s = setup();
    await userEvent.click(changeButtons().find((b) => b.textContent === "use")!);
    await userEvent.click(screen.getByTestId("studio-revert"));
    expect(s().humanize.prepared).toBe(MIXED);
    expect(s().controller.getSource()).toBe(MIXED);
    expect(textOf("studio-summary")).toContain("1 kept as original");
    expect(screen.getByTestId("studio-revert").textContent).toBe("Use the revised wording");
    const kept = changeButtons().find((b) => b.className.includes("chg--kept"))!;
    expect(kept.textContent).toBe("utilize");
    expect(kept.getAttribute("aria-label")).toContain("Kept as the original wording.");
    highlightsOff();
    expect(textOf("studio-revised-text")).toBe(MIXED);
    fireEvent.click(screen.getByTestId("studio-highlight"));
    await userEvent.click(screen.getByTestId("studio-revert"));
    expect(s().humanize.prepared).toBe(ROBOTIC_HUMANIZED);
  });

  it("reverting every change says the original will be typed; a removal can be put back too", async () => {
    const s = setup();
    for (let i = 0; i < 9; i++) {
      await userEvent.click(screen.getByTestId("studio-next"));
      await userEvent.click(screen.getByTestId("studio-revert"));
    }
    expect(s().humanize.prepared).toBe(ROBOTIC);
    expect(screen.getByTestId("studio-banner").textContent).toContain("your original will be typed");
    expect(changeButtons().every((b) => b.className.includes("chg--kept"))).toBe(true);
  });

  it("highlights, views and 'changes only' never change the prepared text", async () => {
    const s = setup();
    const before = s().humanize.prepared;
    const typed = s().controller.getSource();
    highlightsOff();
    fireEvent.click(screen.getByTestId("studio-highlight"));
    for (const v of [/Side by side/, /Original/, /Final text/]) await userEvent.click(screen.getByRole("radio", { name: v }));
    fireEvent.click(screen.getByTestId("studio-only"));
    fireEvent.click(screen.getByTestId("studio-only"));
    await userEvent.click(screen.getByTestId("studio-next"));
    expect(s().humanize.prepared).toBe(before);
    expect(s().controller.getSource()).toBe(typed);
    expect(typed).toBe(ROBOTIC_HUMANIZED);
  });

  it("'changes only' lists each change with context and its reason; selecting one syncs with the text", async () => {
    setup();
    fireEvent.click(screen.getByTestId("studio-only"));
    expect(screen.getByTestId("studio-only").textContent).toContain("Changes only");
    const items = within(screen.getByTestId("studio-list")).getAllByRole("listitem");
    expect(items).toHaveLength(9);
    expect(items[1].textContent).toContain("Reworded");
    expect(items[1].querySelector("del")!.textContent).toBe("utilize");
    expect(items[1].querySelector("ins")!.textContent).toBe("use");
    expect(items[1].textContent).toContain("Simplified an unnecessarily formal expression.");
    expect(items[0].textContent).toMatch(/^1Reworded/);
    await userEvent.click(items[1].querySelector("button")!);
    expect(pos()).toBe("Change 2 of 9");
    expect(items[1].querySelector("button")!.getAttribute("aria-pressed")).toBe("true");
    // In the Original view the list shows only what was there.
    await userEvent.click(screen.getByRole("radio", { name: /Original/ }));
    expect(screen.getByTestId("studio-list").querySelectorAll("ins")).toHaveLength(0);
    fireEvent.click(screen.getByTestId("studio-only"));
    expect(screen.queryByTestId("studio-list")).toBeNull();
    expect(screen.getByTestId("studio-original-text").querySelector(".is-selected")!.textContent).toBe("utilize");
  });

  it("copies the revised or the original text", async () => {
    const s = setup();
    const write = vi.fn(async (_t: string) => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText: write }, configurable: true });
    await userEvent.click(changeButtons().find((b) => b.textContent === "use")!);
    await userEvent.click(screen.getByTestId("studio-revert"));
    await act(async () => fireEvent.click(screen.getByTestId("studio-copy-revised")));
    expect(write).toHaveBeenLastCalledWith(MIXED);
    expect(textOf("studio-note")).toBe("Copied the revised text.");
    await act(async () => fireEvent.click(screen.getByTestId("studio-copy-original")));
    expect(write).toHaveBeenLastCalledWith(ROBOTIC);
    expect(textOf("studio-note")).toBe("Copied the original text.");
    expect(s().text).toBe(ROBOTIC);
    // No clipboard at all: says so instead of pretending.
    write.mockRejectedValue(new Error("blocked"));
    (document as unknown as { execCommand: () => boolean }).execCommand = () => false;
    await act(async () => fireEvent.click(screen.getByTestId("studio-copy-original")));
    expect(textOf("studio-note")).toBe("Couldn't copy: the clipboard isn't available here.");
  });

  it("the copy confirmation clears itself", async () => {
    vi.useFakeTimers();
    try {
      setup();
      Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => {} }, configurable: true });
      await act(async () => fireEvent.click(screen.getByTestId("studio-copy-original")));
      expect(textOf("studio-note")).toBe("Copied the original text.");
      act(() => void vi.advanceTimersByTime(4000));
      expect(textOf("studio-note")).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("restore original and back; re-run checks the original again and clears kept choices", async () => {
    const s = setup();
    await userEvent.click(screen.getByTestId("humanize-restore"));
    expect(s().humanize.prepared).toBe(ROBOTIC);
    expect(screen.getByTestId("studio-banner").textContent).toContain("Your original will be typed.");
    await userEvent.click(screen.getByTestId("humanize-use"));
    expect(s().humanize.prepared).toBe(ROBOTIC_HUMANIZED);

    await userEvent.click(screen.getByTestId("studio-next"));
    await userEvent.click(screen.getByTestId("studio-revert"));
    expect(s().humanize.reverted.size).toBe(1);
    await userEvent.click(screen.getByTestId("studio-rerun"));
    expect(s().humanize.reverted.size).toBe(0);
    expect(s().humanize.runs).toBe(1);
    expect(s().humanize.prepared).toBe(ROBOTIC_HUMANIZED);
    expect(textOf("studio-note")).toBe("Checked your original again from scratch.");
    // A new result starts with nothing selected.
    expect(screen.queryByTestId("studio-explain")).toBeNull();
  });

  it("during a session: looking around works, changing what is typed doesn't", async () => {
    const s = setup();
    act(() => void s().start());
    expect(screen.getByText(/Typing is in progress/)).toBeTruthy();
    await userEvent.click(screen.getByTestId("studio-next"));
    expect(pos()).toBe("Change 1 of 9");
    for (const id of ["studio-revert", "studio-rerun", "humanize-restore"]) expect((screen.getByTestId(id) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("studio-copy-revised") as HTMLButtonElement).disabled).toBe(false);
    act(() => void s().stop());
  });

  it("no Studio when nothing changed", () => {
    setup(NATURAL);
    expect(screen.queryByTestId("studio")).toBeNull();
  });

  it("stays usable on a long document: over a thousand changes, the list shown in pages", async () => {
    const long = (ROBOTIC + "\n\n").repeat(160);
    const expected = humanize(long);
    const n = diffText(long, expected.output).changes.length;
    expect(n).toBeGreaterThan(1400);
    const t0 = performance.now();
    const s = setup(long);
    expect(screen.queryByTestId("studio")).toBeNull(); // over 20,000 characters: checked after a pause in editing
    await act(async () => void (await new Promise((r) => setTimeout(r, 400))));
    expect(changeButtons()).toHaveLength(n);
    expect(performance.now() - t0).toBeLessThan(8000);
    expect(textOf("studio-summary")).toMatch(new RegExp(`^${n.toLocaleString()} changes · `));
    fireEvent.click(screen.getByTestId("studio-only"));
    const items = () => within(screen.getByTestId("studio-list")).getAllByRole("listitem");
    expect(items()).toHaveLength(201);
    const more = `Show 200 more of ${(n - 200).toLocaleString()} remaining`;
    await userEvent.click(screen.getByText(more));
    expect(items()).toHaveLength(401);
    // Walking past the shown part of the list loads more.
    await userEvent.click(items()[399].querySelector("button")!);
    await userEvent.click(screen.getByTestId("studio-next"));
    expect(pos()).toBe(`Change 401 of ${n}`);
    expect(items()).toHaveLength(601);
    expect(s().humanize.prepared).toBe(expected.output);
  });
});

describe("Humanization Studio: punctuation, spacing, additions", () => {
  /** A session slice built from a hand-made pair, to show the change types the rules rarely make. */
  function showPair(original: string, revised: string) {
    const r = { ...humanize(ROBOTIC), source: original, output: revised, edits: [] };
    const h = {
      result: r,
      diff: diffText(original, revised),
      reverted: new Set<number>(),
      usingOriginal: false,
      locked: false,
      setChangeReverted: vi.fn(() => true),
      rerun: vi.fn(() => true),
      typeOriginal: vi.fn(),
      typeHumanized: vi.fn(),
    };
    render(<HumanizeStudio session={{ humanize: h } as unknown as Session} />);
    return h;
  }

  it("boxes punctuation and spacing, marks additions in the original, and explains without guessing", async () => {
    const h = showPair("Wait, what  now\nok", "Wait; what now\n\nok fine");
    const labels = changeButtons().map((b) => [b.className, b.getAttribute("aria-label")]);
    expect(labels).toEqual([
      ["chg chg--fmt", "Punctuation: “,” to “;”."],
      ["chg chg--gone", "Spacing changed."],
      ["chg chg--fmt", "Spacing changed."],
      ["chg chg--add", "Added “␣fine”."],
    ]);
    await userEvent.click(screen.getByTestId("studio-next"));
    expect(textOf("studio-reason")).toBe("Punctuation adjusted");
    await userEvent.click(screen.getByTestId("studio-next"));
    expect(textOf("studio-reason")).toBe("Spacing or line breaks adjusted");
    expect(screen.getByTestId("studio-explain").textContent).toContain("(removed)");
    await userEvent.click(screen.getByTestId("studio-next"));
    await userEvent.click(screen.getByTestId("studio-next"));
    expect(textOf("studio-reason")).toBe("Wording adjusted for flow");
    expect(screen.getByTestId("studio-explain").textContent).toContain("(nothing)");
    await userEvent.click(screen.getByTestId("studio-revert"));
    expect(h.setChangeReverted).toHaveBeenCalledWith(3, true);
    await userEvent.click(screen.getByRole("radio", { name: /Original/ }));
    const orig = changeButtons();
    // The added line break and the added word have nothing in the original: a "+" marks where they go.
    expect(orig.map((b) => b.className)).toEqual(["chg chg--fmt", "chg chg--fmt", "chg chg--gone", "chg chg--gone is-selected"]);
    expect(orig[3].textContent).toBe("+");
    expect(textOf("studio-summary")).toBe("4 changes · 1 word changed · 2 sentences adjusted (0 removed, 1 added)");
  });

  it("shows long or multi-line changes shortened, with line breaks visible", async () => {
    const long = "word ".repeat(30);
    showPair(`Start.\n${long}end`, "Start.\nend");
    await userEvent.click(screen.getByTestId("studio-next"));
    const pair = screen.getByTestId("studio-explain").querySelector(".studio__pair")!.textContent!;
    expect(pair).toMatch(/^word word .*…/);
    expect(pair.length).toBeLessThan(100);
    expect(changeButtons()[0].getAttribute("aria-label")).toMatch(/^Removed “word word .*…”\.$/);
    cleanup();
    showPair("a\nb", "a b");
    expect(changeButtons().at(-1)!.getAttribute("aria-label")).toBe("Spacing changed.");
  });

  it("a kept change that was an addition shows a marker in the final text", () => {
    const original = "The tools work.";
    const revised = "The new tools work.";
    const r = { ...humanize(ROBOTIC), source: original, output: revised, edits: [] };
    const h = { result: r, diff: diffText(original, revised), reverted: new Set([0]), usingOriginal: false, locked: false, setChangeReverted: vi.fn(), rerun: vi.fn(), typeOriginal: vi.fn(), typeHumanized: vi.fn() };
    render(<HumanizeStudio session={{ humanize: h } as unknown as Session} />);
    const b = changeButtons()[0];
    expect(b.className).toBe("chg chg--kept");
    expect(b.textContent).toBe("↺");
    expect(textOf("studio-summary")).toContain("1 kept as original");
  });
});
