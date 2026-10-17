/** The build users install (dist-extension/ and its ZIP), not the test build. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, prepare, test } from "./fixtures";

const dist = resolve(import.meta.dirname, "../dist-extension");
test.use({ extDir: dist });

test("the release build loads with the permissions typing needs, and opens", async ({ sw, context, extId }) => {
  const m = await sw.evaluate(() => chrome.runtime.getManifest());
  expect(m.name).toBe("Typewriter");
  expect(m.permissions?.sort()).toEqual(["debugger", "sidePanel"]);
  expect(m.optional_permissions).toEqual(["clipboardRead"]);
  expect(m.host_permissions ?? []).toEqual([]);
  // Chrome doesn't allow "debugger" to be optional; it must be granted at install.
  expect(await sw.evaluate(() => chrome.permissions.contains({ permissions: ["debugger"] }))).toBe(true);
  expect(await sw.evaluate(() => chrome.sidePanel.getPanelBehavior())).toEqual({ openPanelOnActionClick: true });
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/index.html`);
  await expect(page.getByTestId("btn-start")).toBeVisible();
  await expect(page.locator(".logo-mark__art:visible").first()).toBeVisible();
});

test("the release build (nothing pre-granted) types into a page, exactly", async ({ panel, target }) => {
  const text = "Release build check: Café naïve — 日本語 👍🏽.\nSecond line.";
  await target.locator("#ta").focus();
  await prepare(panel, text, { seconds: 4, countdown: 2 });
  await panel.getByTestId("btn-start").click();
  await expect(panel.getByTestId("ext-verified")).toBeVisible({ timeout: 30_000 });
  expect(await target.locator("#ta").inputValue()).toBe(text);
});

test("the ZIP has the manifest at its root and matches the build", async () => {
  const pkg = JSON.parse(readFileSync(resolve(dist, "manifest.json"), "utf8"));
  const zip = resolve(import.meta.dirname, `../release/typewriter-extension-${pkg.version}.zip`);
  expect(existsSync(zip)).toBe(true);
  const list = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" }).split("\n").filter(Boolean);
  for (const f of ["manifest.json", "index.html", "background.js", "icons/icon-128.png", "theme-init.js"]) expect(list).toContain(f);
  expect(list.some((f) => f.endsWith(".map"))).toBe(false);
  const zipped = execFileSync("unzip", ["-p", zip, "manifest.json"], { encoding: "utf8" });
  expect(JSON.parse(zipped)).toEqual(pkg);
});
