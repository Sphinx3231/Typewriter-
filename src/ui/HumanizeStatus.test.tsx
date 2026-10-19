// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { humanize, rewrite, type HumanizeResult } from "../humanize";
import { NATURAL, ROBOTIC, ROBOTIC_HUMANIZED } from "../humanize/fixtures";
import type { Session } from "../state/useSession";
import { HumanizeStatus } from "./HumanizeStatus";

afterEach(cleanup);

type H = Session["humanize"];
function show(over: Partial<H> = {}, text = ROBOTIC) {
  const h = {
    enabled: true,
    tone: "any",
    checking: false,
    result: humanize(text),
    usingOriginal: false,
    prepared: "",
    locked: false,
    setEnabled: vi.fn(),
    setTone: vi.fn(),
    typeOriginal: vi.fn(),
    typeHumanized: vi.fn(),
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
    expect(screen.queryByText("Details")).toBeNull();
    cleanup();
    show({ result: null });
    expect(headline()).toBe("Checking writing style…");
  });

  it("reports an automatic rewrite with its score, and shows the checks, the edits and both versions", async () => {
    const h = show();
    const r = h.result!;
    expect(headline()).toBe("Humanized automatically");
    expect(line()).toContain(`${r.score}% (${r.flagged} of ${r.applicable} style checks flagged); ${r.edits.length} small edits. This copy is what will be typed.`);
    expect(screen.queryByRole("dialog")).toBeNull();

    await userEvent.click(screen.getByText("Details"));
    expect(screen.getByText(/writing-style heuristic.*does not and cannot tell who, or what, wrote the text/)).toBeTruthy();
    const checks = within(screen.getByTestId("humanize-checks")).getAllByRole("listitem");
    expect(checks).toHaveLength(8);
    expect(checks.some((li) => /Formulaic transitions: flagged/.test(li.textContent!))).toBe(true);
    expect(checks.some((li) => /doesn't apply/.test(li.textContent!))).toBe(true);
    expect(within(screen.getByTestId("humanize-edits")).getAllByRole("listitem")).toHaveLength(r.edits.length);
    expect(screen.getByTestId("humanize-edits").textContent).toContain("utilize → use");
    expect((screen.getByTestId("humanize-original") as HTMLTextAreaElement).value).toBe(ROBOTIC);
    expect((screen.getByTestId("humanize-output") as HTMLTextAreaElement).value).toBe(ROBOTIC_HUMANIZED);
    expect((screen.getByTestId("humanize-original") as HTMLTextAreaElement).readOnly).toBe(true);

    await userEvent.click(screen.getByTestId("humanize-restore"));
    expect(h.typeOriginal).toHaveBeenCalledTimes(1);
  });

  it("names a single edit in the singular and shows a removal", async () => {
    const one: HumanizeResult = { ...humanize(ROBOTIC), edits: [{ rule: "filler", before: "It is important to note that ", after: "" }] };
    show({ result: one });
    expect(line()).toContain("1 small edit.");
    await userEvent.click(screen.getByText("Details"));
    expect(screen.getByTestId("humanize-edits").textContent).toContain("(removed)");
  });

  it("when the user chose the original, says so and offers the humanized copy back", async () => {
    const h = show({ usingOriginal: true });
    expect(headline()).toBe("Typing your original");
    expect(line()).toContain("You chose the original. A humanized copy is ready");
    await userEvent.click(screen.getByText("Details"));
    await userEvent.click(screen.getByTestId("humanize-use"));
    expect(h.typeHumanized).toHaveBeenCalledTimes(1);
  });

  it("can't switch versions while a session is running", async () => {
    show({ locked: true });
    await userEvent.click(screen.getByText("Details"));
    expect((screen.getByTestId("humanize-restore") as HTMLButtonElement).disabled).toBe(true);
  });

  it("says no changes are needed below 50%", async () => {
    show({}, NATURAL);
    expect(headline()).toBe("No changes needed");
    expect(line()).toMatch(/\d+% \(\d of \d style checks flagged\), below 50%\. Your text is typed as written\./);
    await userEvent.click(screen.getByText("Details"));
    expect(screen.queryByTestId("humanize-restore")).toBeNull();
    expect(screen.queryByTestId("humanize-original")).toBeNull();
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
    expect(screen.queryByText("Details")).toBeNull();
  });

  it("shows a clear error when the checklist fails, and that the original will be typed", () => {
    const broken = humanize(ROBOTIC, "any", {
      runChecks: () => {
        throw new Error("checklist crashed");
      },
      rewrite,
    });
    show({ result: broken });
    expect(headline()).toBe("Couldn't humanize");
    expect(screen.getByRole("alert").textContent).toContain("checklist crashed Your original text will be typed.");
    cleanup();
    show({ result: { ...broken, error: undefined } });
    expect(screen.getByRole("alert").textContent).toContain("The style check failed. Your original text will be typed.");
  });
});
