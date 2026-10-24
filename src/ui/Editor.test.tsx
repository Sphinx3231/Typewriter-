// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computeStats, isBlank, type PlaybackStatus } from "../engine";
import { LARGE_TEXT_CHARS, type Session } from "../state/useSession";
import { Editor } from "./Editor";

afterEach(cleanup);

/** The slice of a session the editor reads, built from real text statistics. */
function fakeSession(text: string, status: PlaybackStatus = text ? "ready" : "empty", over: Partial<Session> = {}): Session {
  return {
    text,
    setText: vi.fn(),
    stats: computeStats(text),
    blank: isBlank(text),
    planning: false,
    snapshot: { status },
    analysis: { enabled: false },
    ...over,
  } as unknown as Session;
}

/** Wires setText to real state so typing shows up in the textarea. */
function LiveEditor({ initial = "", onSet }: { initial?: string; onSet?: (t: string) => void }) {
  const [text, setText] = useState(initial);
  const session = fakeSession(text, undefined, {
    setText: (t: string) => {
      onSet?.(t);
      setText(t);
    },
  } as Partial<Session>);
  return <Editor session={session} />;
}

describe("Editor", () => {
  it("starts empty with a sample button and zeroed stats", async () => {
    const session = fakeSession("");
    render(<Editor session={session} />);
    const box = screen.getByRole("textbox", { name: "Your text" }) as HTMLTextAreaElement;
    expect(box.value).toBe("");
    expect(box.readOnly).toBe(false);
    expect(screen.getByTestId("stat-chars").textContent).toBe("0");
    expect(screen.getByTestId("stat-words").textContent).toBe("0");
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Use sample" }));
    expect(session.setText).toHaveBeenCalledWith(expect.stringMatching(/^The quick brown fox jumps over the lazy dog\./));
    expect(document.getElementById("editor-note")!.textContent).toBe("");
  });

  it("passes what the user types through unchanged and updates the stats", async () => {
    const onSet = vi.fn();
    render(<LiveEditor onSet={onSet} />);
    const box = screen.getByRole("textbox", { name: "Your text" }) as HTMLTextAreaElement;
    await userEvent.type(box, "teh cat{Enter}{Enter}sat");
    expect(box.value).toBe("teh cat\n\nsat");
    expect(onSet).toHaveBeenLastCalledWith("teh cat\n\nsat");
    expect(screen.getByTestId("stat-chars").textContent).toBe("12");
    expect(screen.getByTestId("stat-words").textContent).toBe("3");
    const dds = [...document.querySelectorAll(".stat-chip dd")].map((d) => d.textContent);
    expect(dds).toEqual(["12", "3", "3", "2"]);
  });

  it("clears the text only after confirming", async () => {
    const onSet = vi.fn();
    render(<LiveEditor initial="Hello there" onSet={onSet} />);
    expect(screen.queryByRole("button", { name: "Use sample" })).toBeNull();
    const clear = screen.getByRole("button", { name: "Clear" });
    await userEvent.click(clear);
    expect(onSet).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Clear all text?" }));
    expect(onSet).toHaveBeenCalledWith("");
    expect((screen.getByRole("textbox", { name: "Your text" }) as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByRole("button", { name: "Use sample" })).toBeTruthy();
  });

  it.each<PlaybackStatus>(["playing", "paused"])("locks the text while %s", async (status) => {
    const session = fakeSession("Locked words", status);
    render(<Editor session={session} />);
    const box = screen.getByRole("textbox", { name: "Your text" }) as HTMLTextAreaElement;
    expect(box.readOnly).toBe(true);
    expect(box.closest(".editor__box")!.className).toContain("is-locked");
    expect((screen.getByRole("button", { name: "Clear" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Locked while typing\. Stop playback to edit\./)).toBeTruthy();
    await userEvent.type(box, "x");
    expect(session.setText).not.toHaveBeenCalled();
  });

  it("disables the sample button while playback is running on empty text", () => {
    render(<Editor session={fakeSession("", "paused")} />);
    expect((screen.getByRole("button", { name: "Use sample" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("warns when the text is only whitespace", () => {
    render(<Editor session={fakeSession("  \n\t ")} />);
    const note = screen.getByRole("alert");
    expect(note.textContent).toBe("Only spaces or line breaks so far. Add some text to start.");
  });

  it("explains that long text is kept whole", () => {
    const text = "a".repeat(LARGE_TEXT_CHARS + 1);
    render(<Editor session={fakeSession(text)} />);
    const note = document.getElementById("editor-note")!;
    expect(note.textContent).toBe(`Long text (${new Intl.NumberFormat().format(LARGE_TEXT_CHARS + 1)} characters). Nothing is cut off; planning may take a moment.`);
    expect(note.hasAttribute("role")).toBe(false);
  });

  it("shows that the estimate is being updated", () => {
    render(<Editor session={fakeSession("Some words", "ready", { planning: true })} />);
    expect(document.getElementById("editor-note")!.textContent).toBe("Updating estimate…");
  });

  it("says the original is never changed, and with writing analysis on, that it is typed exactly while findings are shown below", () => {
    render(<Editor session={fakeSession("Some words", "ready")} />);
    expect(screen.getByText("This is the original. Typewriter never changes it.")).toBeTruthy();
    expect(screen.queryByTestId("analysis-status")).toBeNull();
    cleanup();
    const text = "Short text.";
    const result = { source: text, findings: [], hits: { vocab: [], phrases: [], punctuation: [], rhythm: [], proof: [] }, counts: { vocab: 0, phrases: 0, punctuation: 0, rhythm: 0, proof: 0 }, ms: 1 };
    const analysis = { enabled: true, checking: false, result, error: null, score: 5, reviewed: new Set() };
    render(<Editor session={fakeSession(text, "ready", { analysis } as unknown as Partial<Session>)} />);
    expect(screen.getByText("This is exactly what will be typed. Writing analysis points things out below; it never changes your text.")).toBeTruthy();
    expect(screen.getByTestId("analysis-headline").textContent).toBe("Nothing to review");
    expect((screen.getByRole("textbox", { name: "Your text" }) as HTMLTextAreaElement).value).toBe(text);
  });
});
