// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useMemo, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildScript,
  DEFAULT_SETTINGS,
  durationForWpm,
  estimate,
  isBlank,
  validateSettings,
  type Estimate,
  type PlaybackSettings,
  type PlaybackStatus,
  type Script,
} from "../engine";
import type { Session } from "../state/useSession";
import { longDuration } from "./format";
import { SettingsPanel } from "./SettingsPanel";

// The output destination block belongs to ExternalPanel and is tested there.
vi.mock("./ExternalPanel", () => ({ OutputSettings: () => <div data-testid="output-settings" /> }));

afterEach(cleanup);

const TEXT = "The quick brown fox jumps over the lazy dog. It is a sentence that uses every letter of the alphabet.";

type Harness = {
  text?: string;
  settings?: Partial<PlaybackSettings>;
  status?: PlaybackStatus;
  est?: Partial<Estimate>;
  script?: Partial<Script>;
  analysis?: { enabled: boolean; allowProof?: boolean };
};

/**
 * Settings held in real state with the real planner behind the estimate, so a
 * change shows up the way it does in the app. `est`/`script` override single
 * fields to reach states that need very specific numbers.
 */
function setup(h: Harness = {}) {
  const spies = { set: vi.fn(), applyDuration: vi.fn(), newVariation: vi.fn(), setAnalysis: vi.fn(), setAllowProof: vi.fn() };
  let latest: Session = null as unknown as Session;
  function Live() {
    const text = h.text ?? TEXT;
    const [settings, setSettings] = useState<PlaybackSettings>({ ...DEFAULT_SETTINGS, ...h.settings });
    const script = useMemo(() => buildScript(text, settings), [text, settings]);
    const session = {
      settings,
      updateSettings: (p: Partial<PlaybackSettings>) => {
        spies.set(p);
        setSettings((s) => ({ ...s, ...p }));
      },
      estimate: { ...estimate(script, settings), ...h.est },
      issues: validateSettings(settings),
      equivalents: { durationForWpm: (wpm: number) => durationForWpm(script, wpm), wpmForDuration: () => 0 },
      snapshot: { status: h.status ?? (isBlank(text) ? "empty" : "ready") },
      blank: isBlank(text),
      script: { ...script, ...h.script },
      applyDuration: spies.applyDuration,
      newVariation: spies.newVariation,
      analysis: { enabled: false, allowProof: false, ...h.analysis, setEnabled: spies.setAnalysis, setAllowProof: spies.setAllowProof },
    } as unknown as Session;
    latest = session;
    return <SettingsPanel session={session} />;
  }
  render(<Live />);
  return { ...spies, session: () => latest };
}

const radio = (name: string) => screen.getByRole("radio", { name });
const checked = (name: string) => radio(name).getAttribute("aria-checked") === "true";
const num = (name: string) => screen.getByRole("spinbutton", { name }) as HTMLInputElement;
const wpmBox = () => screen.getByLabelText("Typing speed", { selector: "input" }) as HTMLInputElement;
const alerts = () => screen.getAllByRole("alert").map((a) => a.textContent);

describe("SettingsPanel header and output", () => {
  it("shows the panel with the output settings", () => {
    setup();
    expect(screen.getByRole("heading", { name: "Session settings" })).toBeTruthy();
    expect(screen.getByText("Saved automatically on this device.")).toBeTruthy();
    expect(screen.getByTestId("output-settings")).toBeTruthy();
  });

  it.each<PlaybackStatus>(["playing", "paused"])("says changes apply on restart while %s", (status) => {
    setup({ status });
    expect(screen.getByText("Changes apply when you restart.")).toBeTruthy();
  });
});

describe("timing by speed", () => {
  it("shows the speed with a slider and how long it will take", () => {
    const { session } = setup();
    expect(checked("Typing speed")).toBe(true);
    const slider = screen.getByRole("slider", { name: "Typing speed in words per minute" }) as HTMLInputElement;
    expect(slider.value).toBe("60");
    expect(slider.getAttribute("aria-valuetext")).toBe("60 words per minute");
    expect(slider.style.getPropertyValue("--fill")).toBe(`${(50 / 190) * 100}%`);
    const secs = session().equivalents.durationForWpm(60);
    expect(screen.getByText(`Takes about ${longDuration(secs * 1000)} with your realism settings`)).toBeTruthy();
    expect(wpmBox().value).toBe("60");
  });

  it("explains words per minute when there is no text yet", () => {
    setup({ text: "" });
    expect(screen.getByText("Words per minute while typing (5 characters = 1 word)")).toBeTruthy();
    expect(screen.queryByTestId("estimate")).toBeNull();
  });

  it("updates the speed from the slider and the number box", async () => {
    const { set } = setup();
    fireEvent.change(screen.getByRole("slider"), { target: { value: "95" } });
    expect(set).toHaveBeenLastCalledWith({ wpm: 95 });
    expect(wpmBox().value).toBe("95");
    const box = wpmBox();
    await userEvent.clear(box);
    await userEvent.type(box, "120{Enter}");
    expect(set).toHaveBeenLastCalledWith({ wpm: 120 });
    expect((screen.getByRole("slider") as HTMLInputElement).value).toBe("120");
  });

  it("pins the slider to its ends for speeds outside its range", () => {
    setup({ settings: { wpm: 300 } });
    const slider = screen.getByRole("slider") as HTMLInputElement;
    expect(slider.value).toBe("200");
    expect(slider.style.getPropertyValue("--fill")).toBe("100%");
    cleanup();
    setup({ settings: { wpm: 6 } });
    const low = screen.getByRole("slider") as HTMLInputElement;
    expect(low.value).toBe("10");
    expect(low.style.getPropertyValue("--fill")).toBe("0%");
    expect(low.getAttribute("aria-valuetext")).toBe("6 words per minute");
  });

  it("flags an invalid speed", () => {
    setup({ settings: { wpm: 2 } });
    expect(alerts()).toEqual([validateSettings({ ...DEFAULT_SETTINGS, wpm: 2 })[0].message]);
    expect(wpmBox().getAttribute("aria-invalid")).toBe("true");
  });

  it("keeps speed mode when it is picked again", async () => {
    const { set } = setup();
    await userEvent.click(radio("Typing speed"));
    expect(set).toHaveBeenCalledWith({ timingMode: "speed" });
  });
});

describe("timing by duration", () => {
  it("switching to duration carries over the current estimate", async () => {
    const { set, session } = setup();
    const total = session().estimate.totalMs;
    await userEvent.click(radio("Total duration"));
    const sec = Math.max(1, Math.round(total / 1000));
    expect(set).toHaveBeenCalledWith({ timingMode: "duration", durationSec: sec });
    expect(num("Minutes").value).toBe(String(Math.floor(sec / 60)));
    expect(num("Seconds").value).toBe(String(sec % 60));
    expect(screen.getByText(/^About \d+ WPM while typing$/)).toBeTruthy();
  });

  it("switching to duration with no text keeps the stored duration", async () => {
    const { set } = setup({ text: "", settings: { durationSec: 125 } });
    await userEvent.click(radio("Total duration"));
    expect(set).toHaveBeenCalledWith({ timingMode: "duration" });
    expect(num("Minutes").value).toBe("2");
    expect(num("Seconds").value).toBe("5");
  });

  it("switching back to speed carries over the keystroke speed", async () => {
    const { set, session } = setup({ settings: { timingMode: "duration", durationSec: 60 } });
    const w = Math.round(session().estimate.keystrokeWpm);
    await userEvent.click(radio("Typing speed"));
    expect(set).toHaveBeenCalledWith({ timingMode: "speed", wpm: w });
  });

  it("clamps the carried-over speed to the allowed range", async () => {
    const { set } = setup({ settings: { timingMode: "duration", durationSec: 60 }, est: { keystrokeWpm: 5000 } });
    await userEvent.click(radio("Typing speed"));
    expect(set).toHaveBeenCalledWith({ timingMode: "speed", wpm: 400 });
  });

  it("falls back to the stored speed when there is no keystroke speed", async () => {
    const { set } = setup({ settings: { timingMode: "duration", durationSec: 60, wpm: 77 }, est: { keystrokeWpm: 0 } });
    await userEvent.click(radio("Typing speed"));
    expect(set).toHaveBeenCalledWith({ timingMode: "speed", wpm: 77 });
  });

  it("switching to speed without text keeps the stored speed", async () => {
    const { set } = setup({ text: " ", settings: { timingMode: "duration" } });
    await userEvent.click(radio("Typing speed"));
    expect(set).toHaveBeenCalledWith({ timingMode: "speed" });
  });

  it("edits minutes and seconds separately", async () => {
    const { set } = setup({ settings: { timingMode: "duration", durationSec: 125 } });
    const min = num("Minutes");
    await userEvent.clear(min);
    await userEvent.type(min, "3{Enter}");
    expect(set).toHaveBeenLastCalledWith({ durationSec: 185 });
    const sec = num("Seconds");
    await userEvent.clear(sec);
    await userEvent.type(sec, "40{Enter}");
    expect(set).toHaveBeenLastCalledWith({ durationSec: 220 });
  });

  it("never goes below one second", async () => {
    const { set } = setup({ settings: { timingMode: "duration", durationSec: 5 } });
    const sec = num("Seconds");
    await userEvent.clear(sec);
    await userEvent.type(sec, "0{Enter}");
    expect(set).toHaveBeenLastCalledWith({ durationSec: 1 });
    cleanup();
    const again = setup({ settings: { timingMode: "duration", durationSec: 60 } });
    const min = num("Minutes");
    await userEvent.clear(min);
    await userEvent.type(min, "0{Enter}");
    expect(again.set).toHaveBeenLastCalledWith({ durationSec: 1 });
  });

  it("flags an invalid duration on both boxes", () => {
    setup({ settings: { timingMode: "duration", durationSec: 0 } });
    expect(alerts()).toContain("Set a duration of at least 1 second.");
    expect(num("Minutes").getAttribute("aria-invalid")).toBe("true");
    expect(num("Seconds").getAttribute("aria-invalid")).toBe("true");
  });
});

describe("estimate", () => {
  it("breaks the total into typing, pauses and corrections in speed mode", () => {
    const { session } = setup({ script: { mistakes: 0 } });
    const est = session().estimate;
    const box = screen.getByTestId("estimate");
    expect(screen.getByTestId("estimate-total").textContent).toMatch(/^\d+:\d\d$/);
    const legend = within(box).getAllByRole("listitem").map((li) => li.textContent);
    expect(legend).toEqual([
      `Typing ${longDuration(est.typingMs)}`,
      `Pauses ${longDuration(est.pauseMs)}`,
      `Corrections ${longDuration(est.correctionMs)}`,
    ]);
    const segs = box.querySelectorAll<HTMLElement>(".estimate__seg");
    expect(segs[0].style.width).toBe(`${(est.typingMs / est.totalMs) * 100}%`);
    expect(box.querySelector(".estimate__note")!.textContent).toBe(
      `Pauses and corrections add time on top of 60 WPM. Average over the session: ${Math.round(est.effectiveWpm)} WPM.`,
    );
  });

  it("explains fitting into a duration and counts one typo", () => {
    setup({ settings: { timingMode: "duration", durationSec: 120 }, script: { mistakes: 1 } });
    expect(screen.getByTestId("estimate").querySelector(".estimate__note")!.textContent).toBe(
      "Pauses and corrections are fitted inside your duration, so the keystrokes get a little faster. This take includes 1 typo.",
    );
  });

  it("counts several typos", () => {
    setup({ script: { mistakes: 3 } });
    expect(screen.getByTestId("estimate").textContent).toContain("This take includes 3 typos.");
  });
});

describe("too-short duration", () => {
  const long = "Sentence after sentence, with commas and pauses. ".repeat(20);

  it("offers the minimum duration that fits", async () => {
    const { applyDuration, session } = setup({ text: long, settings: { timingMode: "duration", durationSec: 1 } });
    const c = session().estimate.conflict!;
    expect(c).not.toBeNull();
    const alert = screen.getByTestId("conflict");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain(`${longDuration(c.requestedMs)} is too short`);
    expect(screen.queryByText(/WPM while typing/)).toBeNull();
    await userEvent.click(within(alert).getByRole("button", { name: `Use ${longDuration(c.minimumMs)}` }));
    expect(applyDuration).toHaveBeenCalledWith(c.minimumMs / 1000);
    expect(screen.queryByTestId("superhuman")).toBeNull();
  });

  it("offers to drop mistakes and pauses when that would be enough", async () => {
    const { set } = setup({
      text: long,
      settings: { timingMode: "duration", durationSec: 30 },
      est: { conflict: { requestedMs: 30_000, minimumMs: 45_000, minimumCleanMs: 20_000 } },
    });
    await userEvent.click(screen.getByRole("button", { name: "Turn off mistakes and pauses" }));
    expect(set).toHaveBeenCalledWith({ mistakes: "off", pauses: false });
  });

  it("offers it with only pauses on", () => {
    setup({
      settings: { timingMode: "duration", durationSec: 30, mistakes: "off", pauses: true },
      est: { conflict: { requestedMs: 30_000, minimumMs: 45_000, minimumCleanMs: 20_000 } },
    });
    expect(screen.getByRole("button", { name: "Turn off mistakes and pauses" })).toBeTruthy();
  });

  it("does not offer it when even clean typing would not fit", () => {
    setup({ settings: { timingMode: "duration" }, est: { conflict: { requestedMs: 30_000, minimumMs: 45_000, minimumCleanMs: 40_000 } } });
    expect(screen.queryByRole("button", { name: "Turn off mistakes and pauses" })).toBeNull();
  });

  it("does not offer it when mistakes and pauses are already off", () => {
    setup({
      settings: { timingMode: "duration", mistakes: "off", pauses: false },
      est: { conflict: { requestedMs: 30_000, minimumMs: 45_000, minimumCleanMs: 20_000 } },
    });
    expect(screen.queryByRole("button", { name: "Turn off mistakes and pauses" })).toBeNull();
  });
});

describe("superhuman speed", () => {
  it("warns and offers a fast human pace in duration mode", async () => {
    const { applyDuration, session } = setup({ settings: { timingMode: "duration", durationSec: 5, mistakes: "off", pauses: false } });
    const est = session().estimate;
    expect(est.conflict).toBeNull();
    expect(est.superhuman).toBe(true);
    const note = screen.getByTestId("superhuman");
    expect(note.getAttribute("role")).toBe("status");
    expect(note.textContent).toContain(`That's about ${new Intl.NumberFormat().format(Math.round(est.keystrokeWpm))} WPM`);
    await userEvent.click(within(note).getByRole("button", { name: `Use ${longDuration(est.humanMinimumMs)} (fast human pace)` }));
    expect(applyDuration).toHaveBeenCalledWith(est.humanMinimumMs / 1000);
  });

  it("only warns in speed mode", () => {
    setup({ settings: { wpm: 300 } });
    const note = screen.getByTestId("superhuman");
    expect(within(note).queryByRole("button")).toBeNull();
  });

  it("does not warn without text", () => {
    setup({ text: "", est: { superhuman: true } });
    expect(screen.queryByTestId("superhuman")).toBeNull();
  });
});

describe("realism", () => {
  it("highlights the matching preset and applies another", async () => {
    const { set } = setup();
    expect(checked("Natural")).toBe(true);
    expect(screen.queryByText("Custom mix. Pick a preset to reset.")).toBeNull();
    await userEvent.click(radio("Clean"));
    expect(set).toHaveBeenLastCalledWith({ rhythm: false, pauses: false, mistakes: "off" });
    expect(checked("Clean")).toBe(true);
    await userEvent.click(radio("Very human"));
    expect(set).toHaveBeenLastCalledWith({ rhythm: true, variation: "high", pauses: true, mistakes: "medium", correction: "mixed" });
    expect(checked("Very human")).toBe(true);
    expect(radio("Clean").getAttribute("title")).toBe("Even keystrokes, no pauses, no mistakes");
  });

  it("marks a mix that matches no preset as custom", async () => {
    setup({ settings: { variation: "low" } });
    expect(["Clean", "Natural", "Very human"].some(checked)).toBe(false);
    expect(screen.getByText("Custom mix. Pick a preset to reset.")).toBeTruthy();
    await userEvent.click(radio("Natural"));
    expect(checked("Natural")).toBe(true);
    expect(screen.queryByText("Custom mix. Pick a preset to reset.")).toBeNull();
  });

  it("toggles rhythm and disables speed variation without it", async () => {
    const { set } = setup();
    const fs = screen.getByRole("radiogroup", { name: "Speed variation" }).closest("fieldset")!;
    expect(fs.disabled).toBe(false);
    await userEvent.click(screen.getByRole("switch", { name: "Realistic rhythm" }));
    expect(set).toHaveBeenLastCalledWith({ rhythm: false });
    expect(fs.disabled).toBe(true);
    expect(screen.getByText("Turn on realistic rhythm to vary the speed.")).toBeTruthy();
  });

  it("changes speed variation", async () => {
    const { set } = setup();
    await userEvent.click(radio("High"));
    expect(set).toHaveBeenLastCalledWith({ variation: "high" });
  });

  it("toggles natural pauses and sounds", async () => {
    const { set } = setup();
    await userEvent.click(screen.getByRole("switch", { name: "Natural pauses" }));
    expect(set).toHaveBeenLastCalledWith({ pauses: false });
    const sound = screen.getByRole("switch", { name: "Typing sounds" });
    expect(sound.getAttribute("aria-checked")).toBe("false");
    await userEvent.click(sound);
    expect(set).toHaveBeenLastCalledWith({ sound: true });
    expect(sound.getAttribute("aria-checked")).toBe("true");
  });

  it("disables correction settings when mistakes are off", async () => {
    const { set } = setup();
    const fs = screen.getByRole("radiogroup", { name: "How typos get fixed" }).closest("fieldset")!;
    expect(fs.disabled).toBe(false);
    expect(fs.hasAttribute("aria-describedby")).toBe(false);
    await userEvent.click(screen.getByRole("radio", { name: "Off" }));
    expect(set).toHaveBeenLastCalledWith({ mistakes: "off" });
    expect(fs.disabled).toBe(true);
    expect(fs.getAttribute("aria-describedby")).toBe("mistakes-off-note");
    expect(document.getElementById("mistakes-off-note")!.textContent).toBe("Turn on typing mistakes to use these.");
  });

  it("changes how typos get fixed", async () => {
    const { set } = setup();
    expect(checked("Mixed")).toBe(true);
    await userEvent.click(radio("Backspace"));
    expect(set).toHaveBeenLastCalledWith({ correction: "backspace" });
    expect(radio("Autocorrect").getAttribute("title")).toBe("The wrong word flashes, then snaps to the right one");
  });

  it("edits the noticing delay range", async () => {
    const { set } = setup();
    const lo = num("Shortest delay in milliseconds");
    const hi = num("Longest delay in milliseconds");
    expect([lo.value, hi.value]).toEqual(["250", "700"]);
    await userEvent.clear(lo);
    await userEvent.type(lo, "300{Enter}");
    expect(set).toHaveBeenLastCalledWith({ correctionDelayMinMs: 300 });
    await userEvent.clear(hi);
    await userEvent.type(hi, "9000{Enter}");
    expect(set).toHaveBeenLastCalledWith({ correctionDelayMaxMs: 5000 });
  });

  it("flags a delay range that runs backwards", () => {
    setup({ settings: { correctionDelayMinMs: 900, correctionDelayMaxMs: 300 } });
    const msg = validateSettings({ ...DEFAULT_SETTINGS, correctionDelayMinMs: 900, correctionDelayMaxMs: 300 }).find(
      (i) => i.field === "correctionDelayMinMs",
    )!.message;
    expect(alerts()).toEqual([msg]);
    expect(num("Shortest delay in milliseconds").getAttribute("aria-invalid")).toBe("true");
    expect(num("Longest delay in milliseconds").getAttribute("aria-invalid")).toBe("true");
  });
});

describe("variation seed", () => {
  it("shows the take number and shuffles", async () => {
    const { newVariation } = setup();
    expect(screen.getByText("Variation #61016")).toBeTruthy();
    await userEvent.click(screen.getByTestId("btn-shuffle"));
    expect(newVariation).toHaveBeenCalledTimes(1);
  });

  it("pads short seeds", () => {
    setup({ settings: { seed: 42 } });
    expect(screen.getByText("Variation #00042")).toBeTruthy();
  });
});

describe("Writing analysis settings", () => {
  const toggle = () => screen.getByRole("switch", { name: /Check writing style/ });

  it("is off by default, explains itself honestly, and turns on with one click", async () => {
    const { setAnalysis } = setup();
    const group = screen.getByTestId("analysis-settings");
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(within(group).getByText(/SlopMonster, an open-source style checker/)).toBeTruthy();
    expect(within(group).getByText(/It never changes your text\. Runs on this device; nothing is sent anywhere\./)).toBeTruthy();
    expect(within(group).queryByRole("switch", { name: /number claims/ })).toBeNull();
    await userEvent.click(toggle());
    expect(setAnalysis).toHaveBeenCalledWith(true);
  });

  it("when on, offers SlopMonster's --allow-proof option, and can be turned off", async () => {
    const { setAnalysis, setAllowProof } = setup({ analysis: { enabled: true } });
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    const proof = screen.getByRole("switch", { name: /My number claims are backed up/ });
    expect(proof.getAttribute("aria-checked")).toBe("false");
    await userEvent.click(proof);
    expect(setAllowProof).toHaveBeenCalledWith(true);
    await userEvent.click(toggle());
    expect(setAnalysis).toHaveBeenCalledWith(false);
  });

  it.each<PlaybackStatus>(["playing", "paused"])("can be switched while %s: it never changes what is typed", (status) => {
    setup({ status, analysis: { enabled: true } });
    expect((toggle() as HTMLButtonElement).disabled).toBe(false);
  });
});
