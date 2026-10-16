/**
 * Chrome extension, end to end: the unpacked test build is loaded into real
 * Chromium, Typewriter's page runs in its own window beside a real web page,
 * and typing arrives as trusted key input through chrome.debugger.
 *
 * Google Docs itself is NOT tested here (no Google account in this environment).
 * "strict-editor.html" is a stand-in with the properties that matter: input via a
 * hidden iframe, text kept off the DOM and drawn on a canvas, untrusted events ignored.
 */
import type { Page, Worker } from "@playwright/test";
import { expect, extStatus, prepare, SITE, test } from "./fixtures";

const TRICKY = [
  "  Leading spaces, Café naïve — 日本語 and emoji 👨‍👩‍👧‍👦 🇯🇵 👍🏽.",
  "",
  "I recieve teh mail evry day; their going tommorow!",
  "\tTabbed line\twith tabs.",
  "Literal, never run: <script>alert(1)</script> $(rm -rf ~) {{x}} %s \\n",
  "",
  "Last line with trailing spaces.   ",
].join("\n");

const value = (page: Page, sel: string) => page.locator(sel).inputValue();
// Without the "tabs" permission (deliberately not requested) tab URLs aren't visible, so find it as the active tab of the normal window.
const targetTabId = (sw: Worker) => sw.evaluate(async () => (await chrome.tabs.query({ active: true, windowType: "normal" }))[0]?.id ?? -1);
const start = (panel: Page) => panel.getByTestId("btn-start").click();

test.describe("installation", () => {
  test("loads with minimal permissions, a service worker and a side panel", async ({ sw }) => {
    const m = await sw.evaluate(() => chrome.runtime.getManifest());
    expect(m.manifest_version).toBe(3);
    expect(m.side_panel?.default_path).toBe("index.html");
    expect(m.host_permissions ?? []).toEqual([]);
    expect(m.content_scripts ?? []).toEqual([]);
    expect(m.permissions?.sort()).toEqual(["clipboardRead", "debugger", "sidePanel"]); // test build: optional ones pre-granted
    expect(await sw.evaluate(() => chrome.sidePanel.getPanelBehavior())).toEqual({ openPanelOnActionClick: true });
    const cmds = await sw.evaluate(() => chrome.commands.getAll());
    expect(cmds.find((c) => c.name === "stop-typing")).toBeTruthy();
  });

  test("the panel page runs without errors or network requests", async ({ context, extId }) => {
    const errors: string[] = [];
    const requests: string[] = [];
    context.on("request", (r) => {
      if (!r.url().startsWith("chrome-extension://") && !r.url().startsWith(SITE)) requests.push(r.url());
    });
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.goto(`chrome-extension://${extId}/index.html`);
    await expect(page.getByTestId("btn-start")).toBeVisible();
    await page.getByTestId("editor").fill("Preview only.");
    await page.waitForTimeout(500);
    expect(errors).toEqual([]);
    expect(requests).toEqual([]);
  });
});

test.describe("panel UI", () => {
  for (const width of [320, 420, 600]) {
    test(`logo and theme at ${width}px wide`, async ({ panel }) => {
      await panel.setViewportSize({ width, height: 860 });
      await expect(panel.locator("#boot")).toHaveCount(0);
      const art = panel.locator(".logo-mark__art:visible").first();
      const logo = () => art.evaluate((el) => ({ pos: getComputedStyle(el).backgroundPosition, img: getComputedStyle(el).backgroundImage, theme: document.documentElement.dataset.theme, w: el.getBoundingClientRect().width }));
      const first = await logo();
      expect(first.img).toMatch(/logo/);
      expect(first.w).toBeGreaterThan(16);
      for (let i = 0; i < 3; i++) {
        const l = await logo();
        expect(l.pos).toBe(l.theme === "dark" ? "100% 0%" : "0% 0%");
        await panel.getByTestId("theme-switch").first().click();
      }
      const chosen = (await logo()).theme;
      await panel.reload();
      await expect(panel.locator("#boot")).toHaveCount(0);
      const after = await logo();
      expect(after.theme).toBe(chosen);
      expect(after.pos).toBe(after.theme === "dark" ? "100% 0%" : "0% 0%");
      // No sideways scrolling in a narrow panel.
      expect(await panel.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      await panel.screenshot({ path: `test-results/extension-panel-${width}-${after.theme}.png` });
      await panel.getByTestId("theme-switch").first().click();
      await panel.waitForTimeout(700); // let the theme cross-fade finish
      await panel.screenshot({ path: `test-results/extension-panel-${width}-${after.theme === "dark" ? "light" : "dark"}.png` });
    });
  }

  test("offers typing into a web page, explains the permission, and labels the button", async ({ panel }) => {
    await panel.getByTestId("editor").fill("x");
    await expect(panel.getByRole("radio", { name: "Into a web page" })).toBeVisible();
    await panel.getByRole("radio", { name: "Into a web page" }).click();
    await expect(panel.getByTestId("permission-explainer")).toContainText("debugger permission");
    await expect(panel.getByTestId("btn-start")).toHaveText(/Type into page/);
    await expect(panel.getByText("Minimise Typewriter while typing")).toHaveCount(0);
  });
});

test.describe("typing into pages", () => {
  test("types unicode, multiline and literal text exactly into a textarea, after the countdown", async ({ panel, target }) => {
    await target.locator("#ta").focus();
    await prepare(panel, TRICKY, { seconds: 10, mistakes: "Medium", countdown: 3 });
    await start(panel);
    await expect(panel.getByTestId("ext-countdown")).toBeVisible();
    await panel.waitForTimeout(1500);
    expect(await value(target, "#ta")).toBe(""); // nothing during the countdown
    expect(await target.evaluate(() => (window as unknown as { keys: number }).keys)).toBe(0);
    await expect(panel.getByTestId("ext-verified")).toBeVisible({ timeout: 30_000 });
    expect(await value(target, "#ta")).toBe(TRICKY);
    // Trusted input only; nothing script-made.
    expect(await target.evaluate(() => (window as unknown as { untrusted?: number }).untrusted ?? 0)).toBe(0);
    expect(await target.evaluate(() => (window as unknown as { keys: number }).keys)).toBeGreaterThan(TRICKY.length / 2);
    await expect(panel.getByTestId("status").first()).toHaveText(/Verified|Complete/);
  });

  test("text is progressive, not pasted at once", async ({ panel, target }) => {
    await target.locator("#ta").focus();
    const text = "This sentence should appear a few characters at a time.";
    await prepare(panel, text, { seconds: 8, countdown: 2 });
    await start(panel);
    await expect.poll(() => value(target, "#ta"), { timeout: 10_000 }).not.toBe("");
    const partial = await value(target, "#ta");
    expect(partial.length).toBeLessThan(text.length);
    expect(text.startsWith(partial)).toBe(true);
    await expect(panel.getByTestId("ext-verified")).toBeVisible({ timeout: 20_000 });
    expect(await value(target, "#ta")).toBe(text);
  });

  test("inserts at the caret without touching surrounding text", async ({ panel, target }) => {
    await target.locator("#ta").fill("BEFORE  AFTER");
    await target.locator("#ta").evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(7, 7));
    await prepare(panel, "middle", { seconds: 3 });
    await start(panel);
    await expect(panel.getByTestId("ext-verified")).toBeVisible({ timeout: 20_000 });
    expect(await value(target, "#ta")).toBe("BEFORE middle AFTER");
  });

  test("single-line fields: types single-line text, refuses text with line breaks", async ({ panel, target }) => {
    await target.locator("#single").focus();
    await prepare(panel, "one line, ünïcödé ✓", { seconds: 3, mistakes: "Medium" });
    await start(panel);
    await expect(panel.getByTestId("ext-verified")).toBeVisible({ timeout: 20_000 });
    expect(await value(target, "#single")).toBe("one line, ünïcödé ✓");

    await target.locator("#single").fill("");
    await target.locator("#single").focus();
    await panel.getByTestId("editor").fill("two\nlines");
    await start(panel);
    await expect(extStatus(panel)).toContainText("single-line field", { timeout: 15_000 });
    expect(await value(target, "#single")).toBe("");
  });

  test("types into a contenteditable editor and verifies it", async ({ panel, target }) => {
    await target.locator("#ce").focus();
    const text = "Rich editor: Café — 👍🏽 and fixed typos, too.";
    await prepare(panel, text, { seconds: 5, mistakes: "Medium" });
    await start(panel);
    await expect(panel.getByTestId("ext-verified")).toBeVisible({ timeout: 20_000 });
    expect(await target.locator("#ce").evaluate((el) => (el as HTMLElement).innerText.replace(/ /g, " "))).toBe(text);
  });

  test("Docs-like stand-in: rejects script-made events, accepts Typewriter's, and is reported as unchecked", async ({ panel, target, context }) => {
    await target.goto(`${SITE}/strict-editor.html`);
    // The stand-in really is strict: synthetic events change nothing.
    const rejected = await target.evaluate(() => {
      const d = (document.querySelector("iframe") as HTMLIFrameElement).contentDocument!;
      d.body.focus();
      d.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
      d.body.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: "a", bubbles: true, cancelable: true }));
      d.execCommand("insertText", false, "a");
      return { text: (window as unknown as { modelText: () => string }).modelText(), rejected: (window as unknown as { model: { rejected: number } }).model.rejected };
    });
    expect(rejected.text).toBe("");
    expect(rejected.rejected).toBeGreaterThanOrEqual(2);

    await target.locator("canvas").click();
    await prepare(panel, TRICKY, { seconds: 10, mistakes: "Medium" });
    await start(panel);
    await expect(panel.getByTestId("ext-unverified")).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByTestId("ext-unverified")).toContainText("hasn't been checked");
    expect(await target.evaluate(() => (window as unknown as { modelText: () => string }).modelText())).toBe(TRICKY);

    // Copy-back check, as a user would do it: copy the document's text, press Check.
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const docText = await target.evaluate(() => (window as unknown as { modelText: () => string }).modelText());
    await panel.evaluate((t) => navigator.clipboard.writeText(t), docText);
    await panel.getByTestId("btn-verify").click();
    await expect(panel.getByTestId("ext-verified")).toBeVisible({ timeout: 10_000 });
  });

  test("handles long text with a short duration", async ({ panel, target }) => {
    const long = Array.from({ length: 40 }, (_, i) => `Line ${i + 1}: the quick brown fox jumps over the lazy dog — ünïcödé.`).join("\n");
    await target.locator("#ta").focus();
    await prepare(panel, long, { seconds: 20, mistakes: "Low" });
    await start(panel);
    await expect(panel.getByTestId("ext-verified")).toBeVisible({ timeout: 60_000 });
    expect(await value(target, "#ta")).toBe(long);
  });

  test("Type again types the text a second time (only when pressed)", async ({ panel, target }) => {
    await target.locator("#ta").focus();
    await prepare(panel, "again.", { seconds: 2 });
    await start(panel);
    await expect(panel.getByTestId("ext-verified")).toBeVisible({ timeout: 20_000 });
    await panel.waitForTimeout(2000);
    expect(await value(target, "#ta")).toBe("again.");
    await expect(panel.getByTestId("btn-start")).toHaveText(/Type again/);
    await start(panel);
    await expect(panel.getByTestId("ext-verified")).toBeVisible({ timeout: 20_000 });
    expect(await value(target, "#ta")).toBe("again.again.");
  });
});

test.describe("safety", () => {
  test("nothing is typed without pressing Start, or in preview mode", async ({ panel, target }) => {
    await target.locator("#ta").focus();
    await prepare(panel, "should never appear", { seconds: 2 });
    await panel.waitForTimeout(3000);
    await panel.getByRole("radio", { name: "Preview here" }).click();
    await start(panel);
    await expect(panel.getByTestId("status").first()).toHaveText("Complete", { timeout: 15_000 });
    expect(await value(target, "#ta")).toBe("");
    expect(await target.evaluate(() => (window as unknown as { keys: number }).keys)).toBe(0);
  });

  test("refuses password and one-time-code fields", async ({ panel, target }) => {
    for (const sel of ["#pw", "#otp"]) {
      await target.locator(sel).focus();
      await prepare(panel, "secret", { seconds: 2 });
      await start(panel);
      await expect(extStatus(panel)).toContainText("never types into password", { timeout: 15_000 });
      expect(await value(target, sel)).toBe("");
    }
  });

  test("waits while no text field has focus", async ({ panel, target }) => {
    await target.locator("#btn").focus();
    await prepare(panel, "waits for a field", { seconds: 2 });
    await start(panel);
    await expect(extStatus(panel)).toContainText("Click into a document or text field", { timeout: 15_000 });
    await panel.waitForTimeout(1000);
    expect(await target.evaluate(() => (window as unknown as { keys: number }).keys)).toBe(0);
    await target.locator("#ta").focus();
    await expect(panel.getByTestId("ext-verified")).toBeVisible({ timeout: 20_000 });
    expect(await value(target, "#ta")).toBe("waits for a field");
  });

  test("Cancel during the countdown types nothing", async ({ panel, target }) => {
    await target.locator("#ta").focus();
    await prepare(panel, "cancelled", { seconds: 2, countdown: 5 });
    await start(panel);
    await expect(panel.getByTestId("ext-countdown")).toBeVisible();
    await panel.getByTestId("btn-cancel").click();
    await panel.waitForTimeout(6000);
    expect(await value(target, "#ta")).toBe("");
  });

  test("pause, resume and stop from the panel", async ({ panel, target }) => {
    await target.locator("#ta").focus();
    const text = "Pausing and resuming must not lose or repeat a single character of this text.";
    await prepare(panel, text, { seconds: 12, mistakes: "Medium" });
    await start(panel);
    await expect.poll(() => value(target, "#ta"), { timeout: 10_000 }).not.toBe("");
    await panel.getByTestId("btn-pause").click();
    await expect(panel.getByTestId("btn-resume")).toBeVisible();
    const atPause = await value(target, "#ta");
    await panel.waitForTimeout(2000);
    expect(await value(target, "#ta")).toBe(atPause);
    await panel.getByTestId("btn-resume").click();
    await expect(panel.getByTestId("ext-verified")).toBeVisible({ timeout: 40_000 });
    expect(await value(target, "#ta")).toBe(text);

    await target.locator("#ta").fill("");
    await target.locator("#ta").focus();
    await start(panel);
    await expect.poll(() => value(target, "#ta"), { timeout: 10_000 }).not.toBe("");
    await panel.getByTestId("btn-stop").click();
    await expect(panel.getByTestId("status").first()).toHaveText(/Stopped/, { timeout: 5000 });
    const atStop = await value(target, "#ta");
    await panel.waitForTimeout(2000);
    expect(await value(target, "#ta")).toBe(atStop);
    expect(atStop.length).toBeLessThan(text.length);
  });

  test("the Stop typing keyboard command stops at once", async ({ panel, target, sw }) => {
    await target.locator("#ta").focus();
    await prepare(panel, "The emergency stop shortcut must stop this immediately.", { seconds: 10 });
    await start(panel);
    await expect.poll(() => value(target, "#ta"), { timeout: 10_000 }).not.toBe("");
    // Chrome delivers the shortcut to the service worker as this command.
    await sw.evaluate(() => (self as unknown as { handleCommand: (c: string) => void }).handleCommand("stop-typing"));
    await expect(panel.getByTestId("status").first()).toHaveText(/Stopped/, { timeout: 5000 });
    const atStop = await value(target, "#ta");
    await panel.waitForTimeout(2000);
    expect(await value(target, "#ta")).toBe(atStop);
  });

  test("switching tabs pauses; it resumes only in the original tab", async ({ panel, target, sw, context }) => {
    await target.locator("#ta").focus();
    const text = "Typing pauses when you switch tabs and never types into the other tab.";
    await prepare(panel, text, { seconds: 10 });
    await start(panel);
    await expect.poll(() => value(target, "#ta"), { timeout: 10_000 }).not.toBe("");
    const tabId = await targetTabId(sw);
    const winId = await sw.evaluate(async (id) => (await chrome.tabs.get(id)).windowId, tabId);
    await sw.evaluate(async ({ w, site }) => (await chrome.tabs.create({ windowId: w, url: `${site}/target.html?other`, active: true })).id!, { w: winId, site: SITE });
    await expect(extStatus(panel)).toContainText("switched tabs", { timeout: 5000 });
    const atSwitch = await value(target, "#ta");
    await panel.getByTestId("btn-resume").click();
    await panel.waitForTimeout(4500);
    expect(await value(target, "#ta")).toBe(atSwitch); // still on the other tab: nothing typed
    const other = context.pages().find((p) => p.url().endsWith("?other"))!;
    expect(await value(other, "#ta")).toBe("");
    expect(await other.evaluate(() => (window as unknown as { keys: number }).keys)).toBe(0);
    await sw.evaluate((id) => chrome.tabs.update(id, { active: true }), tabId);
    await expect(panel.getByTestId("ext-verified")).toBeVisible({ timeout: 30_000 });
    expect(await value(target, "#ta")).toBe(text);
  });

  test("moving focus to another field pauses; nothing goes into that field", async ({ panel, target }) => {
    await target.locator("#ta").focus();
    const text = "Focus moved away, so typing paused and resumed in the right field.";
    await prepare(panel, text, { seconds: 10 });
    await start(panel);
    await expect.poll(() => value(target, "#ta"), { timeout: 10_000 }).not.toBe("");
    await target.locator("#other").focus();
    await expect(extStatus(panel)).toContainText("different field", { timeout: 5000 });
    await panel.waitForTimeout(1000);
    expect(await value(target, "#other")).toBe("");
    await target.locator("#ta").focus();
    await panel.getByTestId("btn-resume").click();
    await expect(panel.getByTestId("ext-verified")).toBeVisible({ timeout: 30_000 });
    expect(await value(target, "#ta")).toBe(text);
    expect(await value(target, "#other")).toBe("");
  });

  test("a reload or navigation stops typing", async ({ panel, target }) => {
    await target.locator("#ta").focus();
    await prepare(panel, "This session ends when the page reloads, partway through.", { seconds: 10 });
    await start(panel);
    await expect.poll(() => value(target, "#ta"), { timeout: 10_000 }).not.toBe("");
    await target.reload();
    await expect(extStatus(panel)).toContainText("navigated or reloaded", { timeout: 5000 });
    await target.locator("#ta").focus();
    await panel.waitForTimeout(2000);
    expect(await value(target, "#ta")).toBe("");
  });

  test("closing the Typewriter panel stops typing and releases the tab", async ({ panel, target, sw }) => {
    await target.locator("#ta").focus();
    await prepare(panel, "The panel closes while this is being typed, so typing must stop.", { seconds: 10 });
    await start(panel);
    await expect.poll(() => value(target, "#ta"), { timeout: 10_000 }).not.toBe("");
    await panel.close();
    await target.waitForTimeout(300);
    const atClose = await value(target, "#ta");
    await target.waitForTimeout(2500);
    expect(await value(target, "#ta")).toBe(atClose);
    // The extension's debugging session ends with it (no lingering "started debugging" bar):
    // the extension can attach again only if its previous session was released.
    const id = await targetTabId(sw);
    const reattach = await sw.evaluate(async (t) => {
      try {
        await chrome.debugger.attach({ tabId: t }, "1.3");
        await chrome.debugger.detach({ tabId: t });
        return "released";
      } catch (e) {
        return String(e);
      }
    }, id);
    expect(reattach).toBe("released");
  });

  test("closing the tab stops typing", async ({ panel, target, sw }) => {
    await target.locator("#ta").focus();
    await prepare(panel, "The tab closes while this is being typed.", { seconds: 10 });
    await start(panel);
    await expect.poll(() => value(target, "#ta"), { timeout: 10_000 }).not.toBe("");
    const id = await targetTabId(sw);
    await sw.evaluate((t) => chrome.tabs.remove(t), id);
    await expect(panel.getByTestId("status").first()).toHaveText(/Stopped/, { timeout: 5000 });
  });

  test("protected browser pages are refused", async ({ panel, sw, target }) => {
    const id = await targetTabId(sw);
    await sw.evaluate((t) => chrome.tabs.update(t, { url: "chrome://version" }), id);
    await expect.poll(() => target.url()).toContain("chrome://version");
    await prepare(panel, "not here", { seconds: 2 });
    await start(panel);
    await expect(extStatus(panel)).toContainText("doesn't let extensions type into this page", { timeout: 15_000 });
  });
});
