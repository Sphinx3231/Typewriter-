// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { humanize, rewrite } from "../humanize";
import { diffText } from "../humanize/diff";
import { NATURAL, ROBOTIC, ROBOTIC_HUMANIZED } from "../humanize/fixtures";
import type { Session } from "../state/useSession";
import { HumanizeStatus } from "./HumanizeStatus";

afterEach(cleanup);

type H = Session["humanize"];
function show(over: Partial<H> = {}, text = ROBOTIC) {
  const result = "result" in over ? over.result! : humanize(text);
  const h = {
    enabled: true,
    tone: "any",
    checking: false,
    result,
    usingOriginal: false,
    prepared: "",
    locked: false,
    diff: result?.status === "humanized" ? diffText(result.source, result.output) : null,
    reverted: new Set<number>(),
    runs: 0,
    setEnabled: vi.fn(),
    setTone: vi.fn(),
    typeOriginal: vi.fn(),
    typeHumanized: vi.fn(),
    setChangeReverted: vi.fn(() => true),
    rerun: vi.fn(() => true),
    ...over,
  } as H;
  render(<HumanizeStatus session={{ humanize: h, blank: !text.trim() } as unknown as Session} />);
  return h;
}
const headline = () => screen.getByTestId("humanize-headline").textContent;
const line = () => screen.getByTestId("humanize-status").querySelector(".humanize__line")!.textContent;

describe("HumanizeStatus", () => {
  it("shows nothing when the feature is off or there is no text", () => {
    show({ enabled: false });
    expect(screen.queryByTestId("humanize-status")).toBeNull();
    cleanup();
    show({}, "  \n");
    expect(screen.queryByTestId("humanize-status")).toBeNull();
  });

  it("says it is checking while the latest edit hasn't been checked yet", () => {
    show({ checking: true });
    expect(headline()).toBe("Checking writing style…");
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryByText("Style checks")).toBeNull();
    expect(screen.queryByTestId("studio")).toBeNull();
    cleanup();
    show({ result: null });
    expect(headline()).toBe("Checking writing style…");
  });

  it("reports an automatic rewrite with its score and change count, opens the Studio, and keeps the checks one click away", async () => {
    const h = show();
    const r = h.result!;
    expect(headline()).toBe("Humanized automatically");
    expect(line()).toContain(`${r.score}% (${r.flagged} of ${r.applicable} style checks flagged); 9 changes. The revised text is what will be typed.`);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("studio")).toBeTruthy();
    // Removal markers (−) are the only extra glyphs in the highlighted text.
    expect(screen.getByTestId("studio-revised-text").textContent!.replaceAll("−", "")).toBe(ROBOTIC_HUMANIZED);

    await userEvent.click(screen.getByText("Style checks"));
    expect(screen.getByText(/writing-style heuristic.*does not and cannot tell who, or what, wrote the text/)).toBeTruthy();
    const checks = within(screen.getByTestId("humanize-checks")).getAllByRole("listitem");
    expect(checks).toHaveLength(8);
    expect(checks.some((li) => /Formulaic transitions: flagged/.test(li.textContent!))).toBe(true);
    expect(checks.some((li) => /doesn't apply/.test(li.textContent!))).toBe(true);

    await userEvent.click(screen.getByTestId("humanize-restore"));
    expect(h.typeOriginal).toHaveBeenCalledTimes(1);
  });

  it("names a single change in the singular; without a diff it counts the recorded edits", () => {
    const one = humanize(ROBOTIC);
    const small = { ...one, source: "We utilize it.", output: "We use it." };
    show({ result: small });
    expect(line()).toContain("; 1 change. The revised text");
    cleanup();
    show({ diff: null });
    expect(line()).toContain(`; ${one.edits.length} edits. The revised text`);
  });

  it("when the user chose the original, says so and offers the revised text back", async () => {
    const h = show({ usingOriginal: true });
    expect(headline()).toBe("Typing your original");
    expect(line()).toContain("You chose the original. A humanized copy is ready");
    expect(screen.getByTestId("studio-banner").textContent).toContain("Your original will be typed.");
    expect(screen.queryByTestId("humanize-restore")).toBeNull();
    await userEvent.click(screen.getByTestId("humanize-use"));
    expect(h.typeHumanized).toHaveBeenCalledTimes(1);
  });

  it("can't switch versions while a session is running", () => {
    show({ locked: true });
    expect((screen.getByTestId("humanize-restore") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("studio-rerun") as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    show({ locked: true, usingOriginal: true });
    expect((screen.getByTestId("humanize-use") as HTMLButtonElement).disabled).toBe(true);
  });

  it("says no changes are needed below 50%", async () => {
    show({}, NATURAL);
    expect(headline()).toBe("No changes needed");
    expect(line()).toMatch(/\d+% \(\d of \d style checks flagged\), below 50%\. Your text is typed as written\./);
    await userEvent.click(screen.getByText("Style checks"));
    expect(screen.getByTestId("humanize-checks")).toBeTruthy();
    expect(screen.queryByTestId("studio")).toBeNull();
    expect(screen.queryByTestId("humanize-restore")).toBeNull();
  });

  it("says when the checks qualified but no safe edit was found", () => {
    show({ result: humanize(NATURAL, "any", { runChecks: () => humanize(ROBOTIC).checks, rewrite }) }, NATURAL);
    expect(headline()).toBe("No changes made");
    expect(line()).toContain("but no safe small edit was found. Your text is typed as written.");
  });

  it("says when the text is too short to check, with no details", () => {
    show({}, "Short text.");
    expect(headline()).toBe("Too short to check");
    expect(line()).toContain("Your text is typed as written.");
    expect(screen.queryByText("Style checks")).toBeNull();
    expect(screen.queryByTestId("studio")).toBeNull();
  });

  it("shows a clear error when the checklist fails, and that the original will be typed", () => {
    const broken = humanize(ROBOTIC, "any", {
      runChecks: () => {
        throw new Error("checklist crashed");
      },
      rewrite,
    });
    show({ result: broken });
    expect(headline()).toBe("Humanization unavailable");
    expect(screen.getByRole("alert").textContent).toContain("checklist crashed Your original text will be typed, exactly as written.");
    expect(screen.queryByTestId("studio")).toBeNull();
    cleanup();
    show({ result: { ...broken, error: undefined } });
    expect(screen.getByRole("alert").textContent).toContain("The style check failed. Your original text will be typed, exactly as written.");
  });
});
