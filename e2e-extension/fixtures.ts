import { chromium, expect, test as base, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const executablePath = process.env.PW_CHROMIUM ?? (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
export const SITE = "http://127.0.0.1:4174";

type Fixtures = { extDir: string; context: BrowserContext; sw: Worker; extId: string; target: Page; panel: Page };

export const test = base.extend<Fixtures>({
  extDir: [resolve(import.meta.dirname, "../dist-extension-test"), { option: true }],
  context: async ({ extDir }, use) => {
    const dir = mkdtempSync(join(tmpdir(), "tw-ext-"));
    const ctx = await chromium.launchPersistentContext(dir, {
      // Extensions need full Chromium (new headless), not Playwright's headless shell.
      ...(executablePath ? { executablePath } : { channel: "chromium" }),
      headless: process.env.HEADED ? false : true,
      viewport: null,
      args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, "--window-size=1200,900", "--no-first-run"],
    });
    await use(ctx);
    await ctx.close();
    rmSync(dir, { recursive: true, force: true });
  },
  sw: async ({ context }, use) => {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    await use(sw);
  },
  extId: async ({ sw }, use) => use(new URL(sw.url()).host),
  target: async ({ context }, use) => {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`${SITE}/target.html`);
    await use(page);
  },
  /** Typewriter's page, opened in its own small popup window (like the side panel, beside the page). */
  panel: async ({ context, sw, extId, target }, use) => {
    void target;
    const url = `chrome-extension://${extId}/index.html`;
    await sw.evaluate((u) => chrome.windows.create({ url: u, type: "popup", width: 420, height: 900 }), url);
    let panel: Page | undefined;
    await expect.poll(() => (panel = context.pages().find((p) => p.url() === url)), { timeout: 10_000 }).toBeTruthy();
    await panel!.waitForLoadState();
    await expect(panel!.getByTestId("btn-start")).toBeVisible();
    await use(panel!);
  },
});
export { expect };

/** Fill in the text and session settings for typing into a page. */
export async function prepare(panel: Page, text: string, o: { seconds?: number; mistakes?: string; countdown?: number } = {}) {
  await panel.getByTestId("editor").fill(text);
  await pickRadio(panel, "Where to type", "Into a web page");
  const cd = panel.getByRole("spinbutton", { name: "Countdown before typing" });
  await cd.fill(String(o.countdown ?? 2));
  await cd.press("Enter");
  await pickRadio(panel, "Set the timing by", "Total duration");
  const min = panel.getByRole("spinbutton", { name: "Minutes", exact: true });
  const sec = panel.getByRole("spinbutton", { name: "Seconds", exact: true });
  await min.fill("0");
  await min.press("Enter");
  await sec.fill(String(o.seconds ?? 6));
  await sec.press("Enter");
  await pickRadio(panel, "Typing mistakes", o.mistakes ?? "Off");
}

export async function pickRadio(page: Page, group: string, option: string) {
  await page.getByRole("radiogroup", { name: group }).getByRole("radio", { name: option, exact: true }).click();
}

export const extStatus = (panel: Page) => panel.getByTestId("ext-status");
