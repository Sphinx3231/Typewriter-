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
  await min.fill(String(minutes));
  await min.press("Enter");
  await sec.fill(String(seconds));
  await sec.press("Enter");
  await sec.blur();
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
