// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyze, CATEGORY_INFO, explain } from "../analysis";
import { STYLED } from "../analysis/corpus";
import { NATURAL, ROBOTIC } from "../analysis/fixtures";
import { useSession, type Session } from "../state/useSession";
import { AnalysisStatus } from "./AnalysisStatus";
import { StudioPanel, studioVisible } from "./AnalysisStudio";

const copied: string[] = [];
vi.mock("./SessionBar", () => ({
  copyText: async (t: string) => {
    copied.push(t);
    return true;
  },
}));

const FAST = { timingMode: "speed", wpm: 400, rhythm: false, pauses: false, mistakes: "off", sound: false };
let latest: Session;
function Live() {
  latest = useSession();
  return (
    <>
      <AnalysisStatus session={latest} />
      <StudioPanel session={latest} />
    </>
  );
}
/** The real session and the real checker (on the main thread: no Worker in jsdom). */
async function setup(text = ROBOTIC, prefs: Record<string, unknown> = {}) {
  localStorage.setItem("typewriter:settings", JSON.stringify(FAST));
  localStorage.setItem("typewriter:prefs", JSON.stringify({ writingAnalysis: true, ...prefs }));
  render(<Live />);
  act(() => latest.setText(text));
  if (analyze(text).findings.length) await screen.findByTestId("studio");
  else await screen.findByText("Nothing to review");
  return () => latest;
}

beforeEach(() => {
  localStorage.clear();
  copied.length = 0;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const marks = () => [...screen.getByTestId("studio-text").querySelectorAll<HTMLButtonElement>("button.find")];
const pos = () => screen.getByTestId("studio-pos").textContent;

describe("Writing analysis panel", () => {
  it("shows the text exactly as typed, with SlopMonster's real findings highlighted where they are", async () => {
    const s = await setup();
    const a = analyze(ROBOTIC);
    expect(s().analysis.result!.findings).toEqual(a.findings);
    expect(screen.getByTestId("studio-text").textContent).toBe(ROBOTIC);
    // Every finding is highlighted at its own words.
    for (const f of a.findings) {
      const own = marks().filter((m) => m.dataset.f!.split(" ").includes(String(f.id)));
      expect(own.map((m) => m.textContent).join(""), f.rule).toBe(f.ranges.map(([x, y]) => ROBOTIC.slice(x, y)).join(""));
    }
    const leverage = marks().find((m) => m.textContent === "leverage")!;
    expect(leverage.className).toContain("find--word");
    expect(leverage.getAttribute("aria-label")).toBe("Vocabulary: “leverage”.");
    const cats = (Object.keys(a.counts) as (keyof typeof a.counts)[]).filter((k) => a.counts[k]);
    expect(screen.getByTestId("studio-summary").textContent).toBe(
      `${a.findings.length} findings in ${cats.length} ${cats.length === 1 ? "category" : "categories"} · SlopMonster score ${s().analysis.score}/5 (${cats.map((k) => `${CATEGORY_INFO[k].title} ${a.counts[k]}`).join(", ")})`,
    );
    expect(screen.getByText(/Nothing here changes your text: it is typed exactly as shown\./)).toBeTruthy();
    expect(s().prepared).toBe(ROBOTIC);
  });

  it("a click explains a finding with SlopMonster's own guidance; the arrows and Alt+Arrow keys go through them in reading order", async () => {
    await setup();
    const a = analyze(ROBOTIC);
    fireEvent.click(marks().find((m) => m.textContent === "leverage")!);
    const lev = a.findings.find((f) => f.excerpt === "leverage")!;
    const box = screen.getByTestId("studio-explain");
    expect(within(box).getByText(`Finding ${lev.id + 1} of ${a.findings.length}`)).toBeTruthy();
    expect(within(box).getByText("Vocabulary")).toBeTruthy();
    expect(screen.getByTestId("studio-reason").textContent).toBe(explain(lev));
    expect(within(box).getByText("SlopMonster rule: “leverage”")).toBeTruthy();
    expect(pos()).toBe(`Finding ${lev.id + 1} of ${a.findings.length}`);
    expect(marks().filter((m) => m.classList.contains("is-selected")).map((m) => m.textContent)).toEqual(["leverage"]);

    fireEvent.click(screen.getByTestId("studio-next"));
    expect(pos()).toBe(`Finding ${lev.id + 2} of ${a.findings.length}`);
    fireEvent.keyDown(screen.getByTestId("studio"), { key: "ArrowUp", altKey: true });
    expect(pos()).toBe(`Finding ${lev.id + 1} of ${a.findings.length}`);
    for (let i = 0; i < a.findings.length + 2; i++) fireEvent.click(screen.getByTestId("studio-next"));
    expect(pos()).toBe(`Finding ${a.findings.length} of ${a.findings.length}`);
    expect((screen.getByTestId("studio-next") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Close explanation" }));
    expect(screen.queryByTestId("studio-explain")).toBeNull();
  });

  it("a stretch inside two findings belongs to both; a click picks the inner one", async () => {
    const text = `${NATURAL} Unlock the power of bees.`;
    await setup(text);
    const both = marks().find((m) => m.textContent === "Unlock")!;
    expect(both.className).toContain("is-nested");
    const a = analyze(text);
    expect(both.dataset.f!.split(" ").map((id) => a.findings[Number(id)].rule).sort()).toEqual(["unlock", "unlock the power"]);
    fireEvent.click(both);
    expect(within(screen.getByTestId("studio-explain")).getByText("SlopMonster rule: “unlock”")).toBeTruthy();
  });

  it("marking a finding reviewed dims it in the text and the list, and can be undone; the text never changes", async () => {
    const s = await setup();
    fireEvent.click(marks().find((m) => m.textContent === "leverage")!);
    await userEvent.click(screen.getByTestId("studio-review"));
    const id = analyze(ROBOTIC).findings.find((f) => f.excerpt === "leverage")!.id;
    expect([...s().analysis.reviewed]).toEqual([id]);
    expect(marks().find((m) => m.textContent === "leverage")!.className).toContain("is-reviewed");
    expect(screen.getByTestId("studio-summary").textContent).toContain("; 1 reviewed");
    expect(screen.getByTestId("studio-review").textContent).toBe("Mark as not reviewed");
    await userEvent.click(screen.getByRole("radio", { name: "Findings" }));
    expect(within(screen.getByTestId("studio-list")).getByText("reviewed")).toBeTruthy();
    await userEvent.click(screen.getByTestId("studio-review"));
    expect(s().analysis.reviewed.size).toBe(0);
    expect(s().prepared).toBe(ROBOTIC);
  });

  it("the Findings view lists every finding with its context, in pages of 200, and a click selects one", async () => {
    let text = "";
    for (let i = 0; i < 60; i++) text += `${STYLED.essay}\n\n`;
    await setup(text);
    const a = analyze(text);
    expect(a.findings.length).toBeGreaterThan(200);
    await userEvent.click(screen.getByRole("radio", { name: "Findings" }));
    const items = () => within(screen.getByTestId("studio-list")).getAllByRole("button").filter((b) => b.dataset.item !== undefined);
    expect(items()).toHaveLength(200);
    expect(items()[0].getAttribute("aria-label")).toBe(`Finding 1: Vocabulary: “In today's”.`);
    fireEvent.click(screen.getByRole("button", { name: /^Show 200 more of/ }));
    expect(items()).toHaveLength(Math.min(400, a.findings.length));
    fireEvent.click(items()[3]);
    expect(pos()).toBe(`Finding 4 of ${a.findings.length.toLocaleString()}`);
    expect(screen.getByTestId("studio-reason").textContent).toBe(explain(a.findings[3]));
  });

  it("highlights can be turned off: the plain text, and no navigation through hidden highlights", async () => {
    await setup();
    fireEvent.click(screen.getByTestId("studio-highlight"));
    expect(screen.getByTestId("studio-text").textContent).toBe(ROBOTIC);
    expect(screen.getByTestId("studio-text").querySelector(".find")).toBeNull();
    expect(pos()).toBe("Highlights off");
    expect((screen.getByTestId("studio-next") as HTMLButtonElement).disabled).toBe(true);
  });

  it("Copy text copies exactly the text; Check again runs the checker again", async () => {
    const s = await setup();
    await userEvent.click(screen.getByTestId("studio-copy"));
    expect(copied).toEqual([ROBOTIC]);
    expect(screen.getByTestId("studio-note").textContent).toBe("Copied your text.");
    await userEvent.click(screen.getByTestId("studio-rerun"));
    expect(s().analysis.runs).toBe(1);
    await screen.findByTestId("studio");
    expect(s().analysis.result!.source).toBe(ROBOTIC);
    expect(s().analysis.rechecked).toBe(true);
    expect(screen.getByTestId("studio-note").textContent).toBe("Checked your text again.");
    // An edit is a new check, not a repeat of the old one.
    act(() => latest.setText(ROBOTIC + " More."));
    await screen.findByTestId("studio");
    expect(s().analysis.rechecked).toBe(false);
    expect(screen.getByTestId("studio-note").textContent).toBe("");
  });

  it("is hidden while off, while checking, and when there is nothing to show", async () => {
    const s = await setup(NATURAL);
    expect(screen.queryByTestId("studio")).toBeNull();
    expect(studioVisible(s())).toBe(false);
    act(() => void s().analysis.setEnabled(false));
    expect(screen.queryByTestId("analysis-status")).toBeNull();
  });
});

describe("Writing analysis status line", () => {
  it("says what SlopMonster found and offers to review it", async () => {
    const s = await setup();
    const a = analyze(ROBOTIC);
    expect(screen.getByTestId("analysis-headline").textContent).toBe(`${a.findings.length} findings to review`);
    expect(screen.getByTestId("analysis-status").textContent).toContain(`SlopMonster score ${s().analysis.score}/5`);
    expect(screen.getByTestId("analysis-status").textContent).toContain("Your text is typed exactly as written.");
    expect(screen.getByTestId("analysis-review")).toBeTruthy();
  });

  it("text with none of its patterns: nothing to review, score 5/5", async () => {
    await setup(NATURAL);
    expect(screen.getByTestId("analysis-status").textContent).toContain("SlopMonster found none of its patterns (score 5/5).");
  });

  it("while checking, says so", async () => {
    await setup();
    act(() => latest.setText(ROBOTIC + " More."));
    expect(screen.getByTestId("analysis-headline").textContent).toBe("Checking writing style…");
    await screen.findByTestId("studio");
  });
});
