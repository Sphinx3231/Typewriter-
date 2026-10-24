import { expect, test, type Page } from "@playwright/test";

const TRICKY = [
  "  Leading spaces, Café naïve — 日本語 and emoji 👨‍👩‍👧‍👦 🇯🇵 👍🏽.",
  "",
  "I recieve teh mail evry day; their going tommorow!",
  "\tTabbed line\twith tabs.",
  "",
  "",
  "Last line with trailing spaces.   ",
].join("\n");

async function setText(page: Page, text: string) {
  await page.getByTestId("editor").fill(text);
}

async function setDuration(page: Page, minutes: number, seconds: number) {
  await page.getByRole("radio", { name: "Total duration" }).click();
  const min = page.getByRole("spinbutton", { name: "Minutes", exact: true });
  const sec = page.getByRole("spinbutton", { name: "Seconds", exact: true });
  // Seconds first: committing the minutes first (say 2:00 → 0) makes the duration 0:01, and React
  // re-renders Seconds as "1" a moment later. If that lands between Playwright's select-all and
  // its typing, "4" becomes "14" (seen 3 times in 600 runs). This way neither field changes while
  // the other is being edited.
  await sec.fill(String(seconds));
  await sec.press("Enter");
  await min.fill(String(minutes));
  await min.press("Enter");
  await min.blur();
  // The duration really took effect (a run that kept a longer one would otherwise only show up as a timeout later).
  await expect(page.getByRole("radio", { name: "Total duration" })).toHaveAttribute("aria-checked", "true");
  await expect(min).toHaveValue(String(minutes));
  await expect(sec).toHaveValue(String(seconds));
}

async function setWpm(page: Page, wpm: number) {
  const input = page.getByRole("spinbutton", { name: "Typing speed", exact: true });
  await input.fill(String(wpm));
  await input.press("Enter");
}

async function pick(page: Page, group: string, option: string) {
  await page.getByRole("radiogroup", { name: group }).getByRole("radio", { name: option, exact: true }).click();
}

const status = (page: Page) => page.getByTestId("status").first();
const output = (page: Page) => page.getByTestId("playback-text").evaluate((el) => el.textContent ?? "");

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("types tricky text with typos and corrections, and the final output matches exactly", async ({ page }) => {
  await setText(page, TRICKY);
  await pick(page, "Typing mistakes", "Medium");
  await pick(page, "How typos get fixed", "Mixed");
  await setDuration(page, 0, 12);
  await expect(page.getByTestId("conflict")).toHaveCount(0);
  await page.getByTestId("btn-start").click();
  await expect(status(page)).toHaveText("Typing");

  // Text appears progressively, never all at once.
  await page.waitForTimeout(1500);
  const partial = await output(page);
  expect(partial.length).toBeGreaterThan(0);
  expect(partial.length).toBeLessThan(TRICKY.length);

  await expect(status(page)).toHaveText("Complete", { timeout: 20_000 });
  expect(await output(page)).toBe(TRICKY);
  await expect(page.getByTestId("verified-badge")).toBeVisible();
  await expect(page.getByTestId("progress-pct")).toHaveText("100");
});

test("simulated typos are visible and get corrected (autocorrect and backspace)", async ({ page }) => {
  const text = Array.from({ length: 30 }, () => "Typewriters require patience because mechanical keyboards respond slowly.").join(" ");
  await setText(page, text);
  await pick(page, "Typing mistakes", "Medium");
  await pick(page, "How typos get fixed", "Autocorrect");
  await setWpm(page, 400);
  await page.getByTestId("btn-start").click();
  // A temporary typo must show up in the playback at some point.
  await expect(page.locator(".paper__text .typo").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".activity")).toContainText("Autocorrected", { timeout: 30_000 });
  await page.getByTestId("btn-stop").click();
  await expect(status(page)).toHaveText("Stopped");

  await pick(page, "How typos get fixed", "Backspace");
  await page.getByTestId("btn-start").click();
  await expect(page.locator(".activity")).toContainText(/Noticed the typo|Spotted/, { timeout: 30_000 });
  await page.getByTestId("btn-stop").click();
});

test("pause keeps everything in place and resume continues to an exact finish", async ({ page }) => {
  await setText(page, TRICKY);
  await setDuration(page, 0, 8);
  await page.getByTestId("btn-start").click();
  await page.waitForTimeout(2000);
  await page.getByTestId("btn-pause").click();
  await expect(status(page)).toHaveText("Paused");
  const atPause = await output(page);
  const elapsed = await page.getByTestId("elapsed").textContent();
  await page.waitForTimeout(2000);
  expect(await output(page)).toBe(atPause);
  expect(await page.getByTestId("elapsed").textContent()).toBe(elapsed);
  await page.getByTestId("btn-resume").click();
  await expect(status(page)).toHaveText("Typing");
  await expect(status(page)).toHaveText("Complete", { timeout: 15_000 });
  expect(await output(page)).toBe(TRICKY);
});

test("stop is not pause; start again and restart begin cleanly from zero", async ({ page }) => {
  await setText(page, TRICKY);
  await setDuration(page, 0, 6);
  await page.getByTestId("btn-start").click();
  await page.waitForTimeout(1500);
  await page.getByTestId("btn-stop").click();
  await expect(status(page)).toHaveText("Stopped");
  const stopped = await output(page);
  await page.waitForTimeout(1000);
  expect(await output(page)).toBe(stopped);
  await expect(page.getByTestId("btn-stop")).toBeDisabled();
  await expect(page.getByTestId("btn-copy")).toBeDisabled();
  await expect(page.getByTestId("btn-start")).toHaveText(/Start again/);

  await page.getByTestId("btn-start").click();
  await page.waitForTimeout(300);
  expect((await output(page)).length).toBeLessThan(stopped.length);

  // Hammer restart: no duplicated text or runaway timers.
  for (let i = 0; i < 8; i++) await page.getByTestId("btn-restart").click();
  await expect(status(page)).toHaveText("Complete", { timeout: 15_000 });
  expect(await output(page)).toBe(TRICKY);
});

test("finishes on time for the requested duration", async ({ page }) => {
  await setText(page, "Timing check. ".repeat(20));
  await pick(page, "Realism preset", "Clean");
  await setDuration(page, 0, 6);
  const t0 = Date.now();
  await page.getByTestId("btn-start").click();
  await expect(status(page)).toHaveText("Complete", { timeout: 15_000 });
  const took = (Date.now() - t0) / 1000;
  expect(took).toBeGreaterThan(5.5);
  expect(took).toBeLessThan(7.2);
});

test("theme switch changes the whole UI, persists, and doesn't interrupt playback", async ({ page }) => {
  const html = page.locator("html");
  const before = await html.getAttribute("data-theme");
  await setText(page, TRICKY);
  await setDuration(page, 0, 6);
  await page.getByTestId("btn-start").click();
  await page.waitForTimeout(1000);
  const len1 = (await output(page)).length;
  await page.getByTestId("theme-switch").click();
  const after = await html.getAttribute("data-theme");
  expect(after).not.toBe(before);
  await page.getByTestId("theme-switch").click();
  await page.getByTestId("theme-switch").click();
  expect(await html.getAttribute("data-theme")).toBe(after);
  await expect(status(page)).toHaveText("Typing");
  await page.waitForTimeout(800);
  expect((await output(page)).length).toBeGreaterThan(len1);
  await expect(status(page)).toHaveText("Complete", { timeout: 15_000 });
  expect(await output(page)).toBe(TRICKY);

  // Palette check from computed tokens.
  const tokens = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return { theme: document.documentElement.dataset.theme, primary: cs.getPropertyValue("--primary").trim(), accent: cs.getPropertyValue("--accent").trim(), bg: cs.getPropertyValue("--bg").trim() };
  });
  if (tokens.theme === "dark") expect(tokens).toMatchObject({ primary: "#ef4444", accent: "#f97316", bg: "#0a0a0d" });
  else expect(tokens).toMatchObject({ primary: "#7c3aed", accent: "#06b6d4" });

  await page.reload();
  expect(await html.getAttribute("data-theme")).toBe(after);
});

test("first launch follows the system theme until the user chooses", async ({ browser }) => {
  for (const scheme of ["dark", "light"] as const) {
    const ctx = await browser.newContext({ colorScheme: scheme });
    const page = await ctx.newPage();
    await page.goto("/");
    expect(await page.locator("html").getAttribute("data-theme")).toBe(scheme);
    await page.getByTestId("theme-switch").click();
    await page.reload();
    expect(await page.locator("html").getAttribute("data-theme")).toBe(scheme === "dark" ? "light" : "dark");
    await ctx.close();
  }
});

test("settings persist across restarts", async ({ page }) => {
  await pick(page, "Typing mistakes", "Medium");
  await pick(page, "How typos get fixed", "Autocorrect");
  await setWpm(page, 87);
  await page.waitForTimeout(400);
  await page.reload();
  await expect(page.getByRole("radiogroup", { name: "Typing mistakes" }).getByRole("radio", { name: "Medium" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("radiogroup", { name: "How typos get fixed" }).getByRole("radio", { name: "Autocorrect" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("spinbutton", { name: "Typing speed", exact: true })).toHaveValue("87");
});

test("empty and whitespace-only input can't start, with a clear message", async ({ page }) => {
  await expect(page.getByTestId("btn-start")).toBeDisabled();
  await expect(status(page)).toHaveText("No text");
  await setText(page, "   \n\t  ");
  await expect(page.getByTestId("btn-start")).toBeDisabled();
  await expect(page.getByText("Only spaces or line breaks so far")).toBeVisible();
  await setText(page, "ok");
  await expect(page.getByTestId("btn-start")).toBeEnabled();
});

test("too-short duration shows a conflict and offers an adjustment", async ({ page }) => {
  await setText(page, "This sentence is long enough that one second will not do. ".repeat(10));
  await setDuration(page, 0, 1);
  await expect(page.getByTestId("conflict")).toBeVisible();
  await page.getByTestId("conflict").getByRole("button", { name: /^Use / }).click();
  await expect(page.getByTestId("conflict")).toHaveCount(0);
});

test("copy gives back the exact original text", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await setText(page, TRICKY);
  await setDuration(page, 0, 3);
  await page.getByTestId("btn-start").click();
  await expect(status(page)).toHaveText("Complete", { timeout: 10_000 });
  await page.getByTestId("btn-copy").click();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe(TRICKY);
});

test("keyboard shortcuts: Ctrl+Enter starts, Space pauses and resumes, Esc stops", async ({ page }) => {
  await setText(page, TRICKY);
  await setDuration(page, 0, 10);
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+Enter");
  await expect(status(page)).toHaveText("Typing");
  await page.locator(".paper__scroll").focus();
  await page.keyboard.press("Space");
  await expect(status(page)).toHaveText("Paused");
  await page.keyboard.press("Space");
  await expect(status(page)).toHaveText("Typing");
  await page.keyboard.press("Escape");
  await expect(status(page)).toHaveText("Stopped");
});

test("history records sessions without storing the text", async ({ page }) => {
  await setText(page, "Short history check.");
  await setDuration(page, 0, 2);
  await page.getByTestId("btn-start").click();
  await expect(status(page)).toHaveText("Complete", { timeout: 10_000 });
  await page.getByTestId("nav-history").click();
  await expect(page.locator("table tbody tr")).toHaveCount(1);
  await expect(page.locator("table")).toContainText("Completed");
  const stored = await page.evaluate(() => JSON.stringify(localStorage));
  expect(stored).not.toContain("Short history check");
});

test("switching views during playback doesn't interrupt it", async ({ page }) => {
  await setText(page, TRICKY);
  await setDuration(page, 0, 5);
  await page.getByTestId("btn-start").click();
  await page.getByTestId("nav-settings").click();
  await page.waitForTimeout(1500);
  await page.getByTestId("nav-history").click();
  await page.getByTestId("nav-workspace").click();
  await expect(status(page)).toHaveText("Complete", { timeout: 10_000 });
  expect(await output(page)).toBe(TRICKY);
});

test("long text stays responsive", async ({ page }) => {
  const long = "Long input keeps the interface responsive while typing continues. ".repeat(1600); // ~105k chars
  await page.getByTestId("editor").evaluate((el, v) => {
    const ta = el as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(ta, v);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }, long);
  await expect(page.getByTestId("stat-chars")).toHaveText(new Intl.NumberFormat().format(long.length), { timeout: 10_000 });
  await setWpm(page, 400);
  await page.getByTestId("btn-start").click();
  await page.waitForTimeout(3000);
  const t0 = Date.now();
  await page.getByTestId("btn-pause").click();
  await expect(status(page)).toHaveText("Paused");
  expect(Date.now() - t0).toBeLessThan(1000);
  const typed = (await output(page)).length;
  expect(typed).toBeGreaterThan(50);
  expect(long.startsWith((await output(page)).replace(/\s+$/, "").slice(0, 40))).toBe(true);
  await page.getByTestId("btn-stop").click();
});

for (const width of [360, 390, 768, 1024, 1280, 1920]) {
  test(`no horizontal overflow at ${width}px in both themes and every view`, async ({ browser }) => {
    for (const scheme of ["light", "dark"] as const) {
      const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme });
      const page = await ctx.newPage();
      await page.goto("/");
      await page.getByRole("button", { name: "Use sample" }).click();
      for (const view of ["workspace", "history", "settings"]) {
        await page.evaluate((v) => (location.hash = v === "workspace" ? "" : `#/${v}`), view);
        await page.waitForTimeout(150);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, `${scheme} ${view} at ${width}px`).toBeLessThanOrEqual(0);
      }
      await ctx.close();
    }
  });
}

test("keyboard-only use: reach and operate the main controls with visible focus", async ({ page }) => {
  await page.getByTestId("editor").fill("Keyboard only.");
  // Theme switch works from the keyboard.
  await page.getByTestId("theme-switch").focus();
  const before = await page.locator("html").getAttribute("data-theme");
  await page.keyboard.press("Enter");
  expect(await page.locator("html").getAttribute("data-theme")).not.toBe(before);
  // Segmented controls move with arrow keys.
  const mistakes = page.getByRole("radiogroup", { name: "Typing mistakes" });
  await mistakes.getByRole("radio", { checked: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(mistakes.getByRole("radio", { name: "Medium" })).toHaveAttribute("aria-checked", "true");
  // Start button is reachable and shows a focus ring.
  const start = page.getByTestId("btn-start");
  await start.focus();
  const ring = await start.evaluate((el) => getComputedStyle(el).boxShadow);
  expect(ring).not.toBe("none");
  await page.keyboard.press("Enter");
  await expect(status(page)).toHaveText("Typing");
  await expect(page.getByTestId("announce")).toHaveText("Typing started.");
  await expect(status(page)).toHaveText("Complete", { timeout: 15_000 });
  await expect(page.getByTestId("announce")).toContainText("matches your text exactly");
});

test("reduced motion: caret doesn't blink", async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.goto("/");
  await page.getByTestId("editor").fill("Reduced motion check, typed slowly enough to look at the caret.");
  await page.getByTestId("btn-start").click();
  await page.waitForTimeout(800);
  const anim = await page.locator(".paper__text .caret").evaluate((el) => getComputedStyle(el).animationName);
  expect(anim).toBe("none");
  await ctx.close();
});

test("chaos: rapid random clicks on every control never corrupt the output", async ({ page }) => {
  await setText(page, TRICKY);
  await pick(page, "Typing mistakes", "Medium");
  await setDuration(page, 0, 5);
  const ids = ["btn-start", "btn-pause", "btn-resume", "btn-stop", "btn-restart", "theme-switch", "btn-shuffle"];
  let seed = 1234;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 120; i++) {
    const id = ids[Math.floor(rand() * ids.length)];
    const el = page.getByTestId(id);
    if ((await el.count()) && (await el.isEnabled())) await el.click({ timeout: 1000 }).catch(() => {});
    if (rand() < 0.3) await page.waitForTimeout(Math.floor(rand() * 250));
  }
  // Bring it home: whatever state we're in, play a full run.
  const s = await status(page).textContent();
  if (s === "Paused") await page.getByTestId("btn-resume").click();
  else if (s !== "Typing") await page.getByTestId("btn-start").click();
  await expect(status(page)).toHaveText("Complete", { timeout: 20_000 });
  expect(await output(page)).toBe(TRICKY);
  await expect(page.getByTestId("verified-badge")).toBeVisible();
});

test("typing sounds play only when enabled and stop instantly when switched off", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __clicks: number; AudioContext: typeof AudioContext };
    w.__clicks = 0;
    const Orig = w.AudioContext;
    w.AudioContext = class extends Orig {
      createBufferSource() {
        w.__clicks++;
        return super.createBufferSource();
      }
    } as typeof AudioContext;
  });
  await page.reload();
  const clicks = () => page.evaluate(() => (window as unknown as { __clicks: number }).__clicks);
  await setText(page, "Sound check, sound check. ".repeat(4));
  await setDuration(page, 0, 4);

  // Off by default: no clicks.
  await page.getByTestId("btn-start").click();
  await page.waitForTimeout(1200);
  expect(await clicks()).toBe(0);
  await page.getByTestId("btn-stop").click();

  // On: clicks happen.
  await page.getByRole("switch", { name: "Typing sounds" }).click();
  await page.getByTestId("btn-start").click();
  await page.waitForTimeout(1200);
  const during = await clicks();
  expect(during).toBeGreaterThan(5);

  // Switched off mid-playback: no more clicks, playback continues.
  await page.getByRole("switch", { name: "Typing sounds" }).click();
  await page.waitForTimeout(100);
  const atOff = await clicks();
  await page.waitForTimeout(1000);
  expect(await clicks()).toBe(atOff);
  await expect(status(page)).toHaveText("Complete", { timeout: 10_000 });
});

test("logo shows the light half in light theme and the dark half in dark theme, instantly and after reload", async ({ page }) => {
  const logo = () =>
    page.locator(".sidebar .logo-mark__art").evaluate((el) => ({ pos: getComputedStyle(el).backgroundPosition, img: getComputedStyle(el).backgroundImage, theme: document.documentElement.dataset.theme }));
  const expectMatch = (l: { pos: string; theme?: string }) => expect(l.pos).toBe(l.theme === "dark" ? "100% 0%" : "0% 0%");
  await expect(page.locator("#boot")).toHaveCount(0); // launch splash clears after mount
  const first = await logo();
  expect(first.img).toMatch(/logo/);
  expectMatch(first);
  // The image must actually load.
  const loaded = await page.evaluate(async (url) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    return [img.naturalWidth, img.naturalHeight];
  }, first.img.replace(/^url\("?|"?\)$/g, ""));
  expect(loaded).toEqual([1254, 1254]);
  for (let i = 0; i < 6; i++) {
    await page.getByTestId("theme-switch").click();
    expectMatch(await logo()); // same frame as the theme change, no reload
  }
  await page.getByTestId("theme-switch").click();
  const chosen = await logo();
  await page.reload();
  const after = await logo();
  expect(after.theme).toBe(chosen.theme);
  expectMatch(after);
});

test("browser preview explains that typing into other apps needs the extension or desktop app", async ({ page }) => {
  await expect(page.getByText("To type into Google Docs or other apps, use the Typewriter Chrome extension or desktop app.")).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "Where to type" })).toHaveCount(0);
});

test.describe("Writing analysis (SlopMonster)", () => {
  const toggle = (page: Page) => page.getByRole("switch", { name: /Check writing style/ });
  const studioText = (page: Page) => page.getByTestId("studio-text").evaluate((el) => el.textContent ?? "");

  test("off by default; on, pasted text is checked automatically and its real findings are highlighted on the text itself; the text is typed exactly, on or off", async ({ page, context }) => {
    const { ROBOTIC, NATURAL } = await import("../src/analysis/fixtures");
    const { analyze } = await import("../src/analysis");
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await setDuration(page, 0, 4);
    await expect(toggle(page)).toHaveAttribute("aria-checked", "false");
    await setText(page, ROBOTIC);
    await expect(page.getByTestId("analysis-status")).toHaveCount(0);
    await toggle(page).click();
    await expect(toggle(page)).toHaveAttribute("aria-checked", "true");

    // A real paste into the editor: no button to press, no dialog.
    await setText(page, "");
    await page.evaluate((t) => navigator.clipboard.writeText(t), ROBOTIC);
    await page.getByTestId("editor").focus();
    await page.keyboard.press("ControlOrMeta+V");
    await expect(page.getByTestId("editor")).toHaveValue(ROBOTIC);
    const a = analyze(ROBOTIC);
    await expect(page.getByTestId("analysis-headline")).toHaveText(`${a.findings.length} findings to review`);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // The panel shows the text itself, character for character, with each finding at its words.
    expect(await studioText(page)).toBe(ROBOTIC);
    const shown = await page.getByTestId("studio-text").locator("button.find").evaluateAll((els) => els.map((e) => [e.textContent, (e as HTMLElement).dataset.f]));
    for (const f of a.findings) expect(shown.filter(([, ids]) => ids!.split(" ").includes(String(f.id))).map(([t]) => t).join(""), f.rule).toBe(f.ranges.map(([x, y]) => ROBOTIC.slice(x, y)).join(""));

    await page.getByTestId("btn-start").click();
    await expect(status(page)).toHaveText("Complete", { timeout: 15_000 });
    expect(await output(page)).toBe(ROBOTIC);
    await expect(page.getByTestId("verified-badge")).toBeVisible();
    await expect(page.getByTestId("editor")).toHaveValue(ROBOTIC);

    // Nothing to find: said so, and typed as written.
    await setText(page, NATURAL);
    await expect(page.getByTestId("analysis-headline")).toHaveText("Nothing to review");
    await expect(page.getByTestId("studio")).toHaveCount(0);
    await page.getByTestId("btn-start").click();
    await expect(status(page)).toHaveText("Complete", { timeout: 15_000 });
    expect(await output(page)).toBe(NATURAL);

    // The setting survives a reload; off again: no checking, exact typing.
    await page.reload();
    await expect(toggle(page)).toHaveAttribute("aria-checked", "true");
    await toggle(page).click();
    await setText(page, ROBOTIC);
    await expect(page.getByTestId("analysis-status")).toHaveCount(0);
    await expect(page.getByTestId("studio")).toHaveCount(0);
    await page.getByTestId("btn-start").click();
    await expect(status(page)).toHaveText("Complete", { timeout: 15_000 });
    expect(await output(page)).toBe(ROBOTIC);
  });

  test("findings: select, explanation from SlopMonster's guidance, navigation, reviewed marks, the list, copy and check again", async ({ page, context }) => {
    const { STYLED } = await import("../src/analysis/corpus");
    const { analyze, explain } = await import("../src/analysis");
    const text = STYLED.essay;
    const a = analyze(text);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await toggle(page).click();
    await setText(page, text);
    const studio = page.getByTestId("studio");
    await expect(studio).toBeVisible();
    await expect(page.getByTestId("studio-summary")).toContainText(`${a.findings.length} findings in`);

    const lev = a.findings.find((f) => f.excerpt === "leverage")!;
    await studio.locator("button.find", { hasText: /^leverage$/ }).click();
    await expect(page.getByTestId("studio-pos")).toHaveText(`Finding ${lev.id + 1} of ${a.findings.length}`);
    await expect(page.getByTestId("studio-reason")).toHaveText(explain(lev));
    await page.getByTestId("studio-next").click();
    await expect(page.getByTestId("studio-reason")).toHaveText(explain(a.findings[lev.id + 1]));
    await page.keyboard.press("Alt+ArrowUp");
    await expect(page.getByTestId("studio-pos")).toHaveText(`Finding ${lev.id + 1} of ${a.findings.length}`);

    await page.getByTestId("studio-review").click();
    await expect(page.getByTestId("studio-summary")).toContainText("; 1 reviewed");
    await expect(studio.locator("button.find.is-reviewed", { hasText: /^leverage$/ })).toHaveCount(1);
    await page.getByRole("radio", { name: "Findings" }).click();
    await expect(page.getByTestId("studio-list").locator("button[data-item]")).toHaveCount(a.findings.length);
    await expect(page.getByTestId("studio-list").locator(`button[data-item="${lev.id}"]`)).toContainText("reviewed");
    await page.getByRole("radio", { name: "Your text" }).click();

    await page.getByTestId("studio-copy").click();
    await expect(page.getByTestId("studio-note")).toHaveText("Copied your text.");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);
    await page.getByTestId("studio-rerun").click();
    await expect(page.getByTestId("studio-note")).toHaveText("Checked your text again.");
    await expect(page.getByTestId("studio-summary")).not.toContainText("reviewed");
    expect(await studioText(page)).toBe(text);
  });

  test("Unicode, emoji, curly quotes, tabs and Windows line breaks: found in place, typed exactly", async ({ page }) => {
    const text = "🚀 Café — it isn’t just a tool,\r\n\tit’s a platform. Our cutting‑edge app is trusted by 10,000+ happy users. 👨‍👩‍👧‍👦\r\n";
    const { analyze } = await import("../src/analysis");
    await setDuration(page, 0, 4);
    await toggle(page).click();
    await setText(page, text);
    await expect(page.getByTestId("studio")).toBeVisible();
    const editorValue = await page.getByTestId("editor").inputValue();
    // The browser keeps \r\n out of a textarea's value: the app types and checks what it holds.
    const a = analyze(editorValue);
    expect(await studioText(page)).toBe(editorValue);
    await expect(page.getByTestId("studio").locator("button.find", { hasText: "cutting‑edge" })).toHaveCount(1);
    await expect(page.getByTestId("analysis-headline")).toHaveText(`${a.findings.length} findings to review`);
    await page.getByTestId("btn-start").click();
    await expect(status(page)).toHaveText("Complete", { timeout: 15_000 });
    expect(await output(page)).toBe(editorValue);
  });

  test("can be turned on or off while typing: what is typed never changes", async ({ page }) => {
    const { ROBOTIC } = await import("../src/analysis/fixtures");
    await setDuration(page, 0, 6);
    await setText(page, ROBOTIC);
    await page.getByTestId("btn-start").click();
    await expect(status(page)).toHaveText("Typing");
    await expect(toggle(page)).toBeEnabled();
    await toggle(page).click();
    await expect(page.getByTestId("studio")).toBeVisible();
    await toggle(page).click();
    await expect(status(page)).toHaveText("Complete", { timeout: 15_000 });
    expect(await output(page)).toBe(ROBOTIC);
  });

  test("checks on this device: no request leaves the page's own origin while checking", async ({ page }) => {
    const { ROBOTIC } = await import("../src/analysis/fixtures");
    const origin = new URL(page.url()).origin;
    const outside: string[] = [];
    page.on("request", (r) => {
      if (!r.url().startsWith(origin) && !r.url().startsWith("data:") && !r.url().startsWith("blob:")) outside.push(r.url());
    });
    await toggle(page).click();
    await setText(page, ROBOTIC + "\n\n" + ROBOTIC);
    await expect(page.getByTestId("studio")).toBeVisible();
    await page.getByTestId("studio-rerun").click();
    await expect(page.getByTestId("studio")).toBeVisible();
    expect(outside).toEqual([]);
  });

  test("both themes: highlights use each theme's own colors and stay readable; screenshots", async ({ page }) => {
    const { ROBOTIC } = await import("../src/analysis/fixtures");
    await toggle(page).click();
    await setText(page, ROBOTIC);
    await expect(page.getByTestId("studio")).toBeVisible();
    await page.getByTestId("studio-next").click();
    const look = () =>
      page.evaluate(() => {
        const word = document.querySelector('[data-testid="studio-text"] .find--word')!;
        const st = getComputedStyle(word);
        return { theme: document.documentElement.dataset.theme, bg: st.backgroundColor, fg: st.color, line: st.textDecorationColor };
      });
    const first = await look();
    await page.getByTestId("studio").screenshot({ path: `test-results/analysis-${first.theme}.png` });
    await page.getByTestId("theme-switch").click();
    const second = await look();
    await page.getByTestId("studio").screenshot({ path: `test-results/analysis-${second.theme}.png` });
    expect(new Set([first.theme, second.theme])).toEqual(new Set(["light", "dark"]));
    expect(second.bg).not.toBe(first.bg);
    expect(second.line).not.toBe(first.line);
    // Light: a blue underline. Dark: an orange one.
    const rgb = (c: string) => c.match(/\d+(\.\d+)?/g)!.map(Number);
    const light = first.theme === "light" ? first : second;
    const dark = first.theme === "dark" ? first : second;
    const [lr, , lb] = rgb(light.line);
    expect(lb).toBeGreaterThan(lr);
    const [dr, dg, db] = rgb(dark.line);
    expect(dr).toBeGreaterThan(200);
    expect(dg).toBeGreaterThan(100);
    expect(db).toBeLessThan(100);
  });

  for (const width of [1920, 1440, 1280, 1260, 1100, 1028, 1025, 1024, 900, 700, 390]) {
    test(`layout at ${width}px: the panel fits, nothing covers it, no horizontal overflow`, async ({ browser }) => {
      const { ROBOTIC } = await import("../src/analysis/fixtures");
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      await page.goto("/");
      await page.getByRole("switch", { name: /Check writing style/ }).click();
      await setText(page, ROBOTIC);
      await page.getByTestId("analysis-review").click();
      await expect(page.getByTestId("studio")).toBeFocused();
      await expect(page.getByTestId("studio")).toBeInViewport();
      await page.getByTestId("studio-next").click();
      const m = await page.evaluate(() => {
        const studio = document.querySelector('[data-testid="studio"]')!.getBoundingClientRect();
        const text = document.querySelector('[data-testid="studio-text"]')!.getBoundingClientRect();
        return {
          inside: text.left >= studio.left - 0.5 && text.right <= studio.right + 0.5,
          width: text.width,
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          selected: [...document.querySelectorAll('[data-testid="studio"] .is-selected')].length,
        };
      });
      const covered = await page.evaluate(() => {
        const t = document.querySelector('[data-testid="studio-text"]')!;
        t.scrollIntoView({ block: "center" });
        const r = t.getBoundingClientRect();
        const y = Math.max(r.top, 0) + Math.min(r.height, innerHeight) / 2;
        return [r.left + 10, r.left + r.width / 2, r.right - 10].some((x) => !t.contains(document.elementFromPoint(x, y)));
      });
      expect(m.inside).toBe(true);
      expect(m.overflow).toBe(0);
      expect(covered).toBe(false);
      expect(m.width).toBeGreaterThan(Math.min(300, width - 80));
      expect(m.selected).toBeGreaterThan(0);
      await page.close();
    });
  }

  test("long documents stay responsive: an 800-paragraph essay and a 500,000-character paragraph", async ({ page }) => {
    const { ROBOTIC } = await import("../src/analysis/fixtures");
    const { analyze } = await import("../src/analysis");
    await toggle(page).click();
    const essay = (ROBOTIC + "\n\n").repeat(267).trimEnd(); // 801 paragraphs
    let paragraph = "";
    while (paragraph.length < 500_000) paragraph += ROBOTIC.replace(/\n+/g, " ") + " ";
    for (const [name, text] of [
      ["800 paragraphs", essay],
      ["500,000-character paragraph", paragraph],
    ] as const) {
      const n = analyze(text).findings.length;
      const t0 = Date.now();
      await setText(page, text);
      // While the check runs (off the main thread), the page keeps answering.
      const t1 = Date.now();
      await page.getByTestId("theme-switch").click();
      const answered = Date.now() - t1;
      await expect(page.getByTestId("analysis-headline")).toHaveText(`${n.toLocaleString("en-US")} findings to review`, { timeout: 30_000 });
      await expect(page.getByTestId("studio")).toBeVisible();
      const shown = Date.now() - t0;
      const t2 = Date.now();
      for (let i = 0; i < 20; i++) await page.getByTestId("studio-next").click();
      await expect(page.getByTestId("studio-pos")).toHaveText(`Finding 20 of ${n.toLocaleString("en-US")}`);
      await page.getByRole("radio", { name: "Findings" }).click();
      await expect(page.getByTestId("studio-list").locator("button[data-item]")).toHaveCount(200);
      await page.getByRole("radio", { name: "Your text" }).click();
      const stepped = Date.now() - t2;
      expect(await studioText(page)).toBe(text);
      console.log(`${name} (${text.length} chars, ${n} findings): theme switch answered in ${answered} ms while checking; panel shown after ${shown} ms; 20 steps + 2 view changes ${stepped} ms`);
      expect(shown).toBeLessThan(20_000);
      expect(stepped).toBeLessThan(15_000);
    }
  });
});
