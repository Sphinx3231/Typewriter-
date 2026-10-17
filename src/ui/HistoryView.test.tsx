// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFS, type HistoryEntry, type Session } from "../state/useSession";
import { HistoryView } from "./HistoryView";

afterEach(cleanup);

let seq = 0;
function entry(over: Partial<HistoryEntry> = {}): HistoryEntry {
  seq++;
  return {
    id: `h${seq}`,
    startedAt: new Date(2026, 9, 1, 9, seq % 60).toISOString(),
    endedAt: new Date(2026, 9, 1, 10, 0).toISOString(),
    status: "completed",
    characters: 1200,
    words: 200,
    plannedMs: 125_000,
    elapsedMs: 125_000,
    mistakes: 3,
    timingMode: "speed",
    wpm: 58,
    correction: "mixed",
    mistakeLevel: "low",
    ...over,
  };
}

function fakeSession(history: HistoryEntry[], over: Partial<Session> = {}): Session {
  return {
    history,
    prefs: { ...DEFAULT_PREFS },
    clearHistory: vi.fn(),
    deleteHistoryEntry: vi.fn(),
    ...over,
  } as unknown as Session;
}

/** History held in real state so delete and clear change what is shown. */
function LiveHistory({ initial }: { initial: HistoryEntry[] }) {
  const [history, setHistory] = useState(initial);
  const session = fakeSession(history, {
    clearHistory: () => setHistory([]),
    deleteHistoryEntry: (id: string) => setHistory((h) => h.filter((e) => e.id !== id)),
  } as Partial<Session>);
  return <HistoryView session={session} />;
}

const bodyRows = () => screen.getAllByRole("row").slice(1);

describe("HistoryView", () => {
  it("shows an empty state with nothing recorded", () => {
    const session = fakeSession([]);
    render(<HistoryView session={session} />);
    expect(screen.getByText("No sessions yet")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText(/words typed in completed sessions/)).toBeNull();
    expect((screen.getByRole("button", { name: "Clear" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(/History is turned off/)).toBeNull();
    expect(screen.queryByRole("navigation", { name: "History pages" })).toBeNull();
  });

  it("notes when history recording is turned off", () => {
    render(<HistoryView session={fakeSession([], { prefs: { ...DEFAULT_PREFS, keepHistory: false } })} />);
    expect(screen.getByText("History is turned off in Settings, so new sessions aren't recorded.")).toBeTruthy();
  });

  it("lists sessions with their stats and totals only completed words", () => {
    const done = entry({ words: 200, characters: 1200, elapsedMs: 125_000, wpm: 58, mistakes: 3 });
    const stopped = entry({ status: "stopped", words: 50, elapsedMs: 30_000, plannedMs: 90_000, mistakeLevel: "off", mistakes: 0 });
    render(<HistoryView session={fakeSession([done, stopped])} />);
    expect(screen.getByText(/200 words typed in completed sessions\./)).toBeTruthy();
    const [r1, r2] = bodyRows();
    const cells1 = within(r1).getAllByRole("cell").map((c) => c.textContent);
    expect(cells1.slice(1, 7)).toEqual(["200", new Intl.NumberFormat().format(1200), "2:05", "58 WPM", "3", "Completed"]);
    expect(cells1[0]).not.toBe("");
    const cells2 = within(r2).getAllByRole("cell").map((c) => c.textContent);
    expect(cells2.slice(3, 7)).toEqual(["0:30 / 1:30", "58 WPM", "off", "Stopped"]);
  });

  it("filters by status and reports when nothing matches", async () => {
    render(<HistoryView session={fakeSession([entry(), entry(), entry({ status: "stopped" })])} />);
    expect(bodyRows()).toHaveLength(3);
    await userEvent.click(screen.getByRole("radio", { name: "Stopped" }));
    expect(bodyRows()).toHaveLength(1);
    await userEvent.click(screen.getByRole("radio", { name: "Completed" }));
    expect(bodyRows()).toHaveLength(2);
    await userEvent.click(screen.getByRole("radio", { name: "All" }));
    expect(bodyRows()).toHaveLength(3);
  });

  it("says no session matches the filter when history exists", async () => {
    render(<HistoryView session={fakeSession([entry()])} />);
    await userEvent.click(screen.getByRole("radio", { name: "Stopped" }));
    expect(screen.getByText("No sessions match this filter")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("deletes a single session", async () => {
    const a = entry({ words: 11 });
    const b = entry({ words: 22 });
    render(<LiveHistory initial={[a, b]} />);
    const buttons = screen.getAllByRole("button", { name: "Delete this session" });
    await userEvent.click(buttons[0]);
    expect(bodyRows()).toHaveLength(1);
    expect(within(bodyRows()[0]).getAllByRole("cell")[1].textContent).toBe("22");
  });

  it("clears all history after confirming", async () => {
    render(<LiveHistory initial={[entry(), entry()]} />);
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(bodyRows()).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: "Delete all history?" }));
    expect(screen.getByText("No sessions yet")).toBeTruthy();
  });

  it("pages through more than fifteen sessions and resets the page when filtering", async () => {
    const many = Array.from({ length: 20 }, (_, i) => entry({ words: i + 1, status: i < 17 ? "completed" : "stopped" }));
    render(<HistoryView session={fakeSession(many)} />);
    const nav = screen.getByRole("navigation", { name: "History pages" });
    const prev = within(nav).getByRole("button", { name: "Previous" }) as HTMLButtonElement;
    const next = within(nav).getByRole("button", { name: "Next" }) as HTMLButtonElement;
    expect(nav.textContent).toContain("1–15 of 20");
    expect(bodyRows()).toHaveLength(15);
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(false);
    await userEvent.click(next);
    expect(nav.textContent).toContain("16–20 of 20");
    expect(bodyRows()).toHaveLength(5);
    expect(within(bodyRows()[0]).getAllByRole("cell")[1].textContent).toBe("16");
    expect(next.disabled).toBe(true);
    expect(prev.disabled).toBe(false);
    await userEvent.click(prev);
    expect(nav.textContent).toContain("1–15 of 20");
    await userEvent.click(next);
    await userEvent.click(screen.getByRole("radio", { name: "Completed" }));
    const nav2 = screen.getByRole("navigation", { name: "History pages" });
    expect(nav2.textContent).toContain("1–15 of 17");
  });

  it("stays on a valid page when the list shrinks", () => {
    const many = Array.from({ length: 16 }, () => entry());
    const { rerender } = render(<HistoryView session={fakeSession(many)} />);
    screen.getByRole("button", { name: "Next" }).click();
    rerender(<HistoryView session={fakeSession(many.slice(0, 3))} />);
    expect(bodyRows()).toHaveLength(3);
    expect(screen.queryByRole("navigation", { name: "History pages" })).toBeNull();
  });
});
