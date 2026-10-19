/**
 * Desktop end-to-end test: the packaged Typewriter app types into a real
 * Chromium window on a real X11 display, with real key events.
 *
 *   Xvfb + openbox            a desktop with a window manager (focus, minimise)
 *   tauri-driver/WebDriver    operates Typewriter's own UI, like a user would
 *   Chromium (target.html)    the destination document; read back via CDP
 *   xdotool                   the user's clicks, window switches and shortcut presses
 *
 * Nothing in Typewriter's native input path is mocked.
 *
 * Usage: node e2e-desktop/run.mjs [path/to/typewriter-binary]
 * Needs: Xvfb, openbox, xdotool, tauri-driver, WebKitWebDriver (Linux).
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
/** The Smart Humanization sample texts, read from the unit-test fixtures so both suites check the same strings (LF line endings, as in the repository; a Windows checkout may have CRLF). */
const FIXTURES = Object.fromEntries(
  [...readFileSync(join(here, "..", "src", "humanize", "fixtures.ts"), "utf8").replace(/\r\n/g, "\n").matchAll(/export const (\w+) = `([^`]*)`;/g)].map((m) => [m[1], m[2]]),
);
const APP = resolve(process.argv[2] ?? join(here, "../src-tauri/target/release/typewriter"));
const DISPLAY = ":99";
const env = { ...process.env, DISPLAY, XDG_SESSION_TYPE: "x11", GDK_BACKEND: "x11", HOME: mkdtempSync(join(tmpdir(), "tw-home-")) };
const CHROMIUM = process.env.PW_CHROMIUM ?? (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);

const procs = [];
const SHOTS = process.env.SHOTS;
function shot(name) {
  if (!SHOTS) return;
  try {
    execFileSync("import", ["-window", "root", join(SHOTS, `${name}.png`)], { env });
  } catch {
    /* screenshots are optional */
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let failures = 0;

function bg(cmd, args, extra = {}) {
  const p = spawn(cmd, args, { env, stdio: "ignore", ...extra });
  procs.push(p);
  return p;
}
const xdo = (...args) => execFileSync("xdotool", args, { env }).toString().trim();

async function check(name, fn) {
  if (process.env.ONLY && !new RegExp(process.env.ONLY).test(name)) return;
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`  ✓ ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    failures++;
    results.push({ name, ok: false, error: String(e?.stack ?? e) });
    console.log(`  ✘ ${name}\n    ${String(e?.message ?? e).split("\n").join("\n    ")}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
async function until(fn, timeoutMs, what) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    last = await fn();
    if (last) return last;
    await sleep(100);
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
}

// ---------------------------------------------------------------- WebDriver
const WD = "http://127.0.0.1:4444";
let sid = null;
async function wd(method, path, body) {
  const r = await fetch(`${WD}${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (j.value && j.value.error) throw new Error(`WebDriver ${path}: ${j.value.error} ${j.value.message}`);
  return j.value;
}
async function openApp() {
  const v = await wd("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application: APP } } } });
  sid = v.sessionId;
  await until(() => js(`return !!document.querySelector('[data-testid="btn-start"]')`), 30000, "Typewriter UI");
}
async function closeApp() {
  if (sid) await wd("DELETE", `/session/${sid}`).catch(() => {});
  sid = null;
  await sleep(800);
}
const js = (script, ...args) => wd("POST", `/session/${sid}/execute/sync`, { script, args });

// Small helpers that run inside Typewriter's page.
const UI = `
  window.__tw = {
    setText(v) {
      const ta = document.getElementById("source-text");
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(ta, v);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    },
    radio(group, option) {
      const g = [...document.querySelectorAll('[role="radiogroup"]')].find((x) => x.getAttribute("aria-label") === group);
      [...g.querySelectorAll('[role="radio"]')].find((x) => x.textContent.trim() === option).click();
    },
    number(input, v) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, String(v));
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    },
    byLabel(text) {
      const l = [...document.querySelectorAll("label")].find((x) => x.textContent.trim() === text);
      return document.getElementById(l.htmlFor);
    },
    click(testid) { document.querySelector('[data-testid="' + testid + '"]').click(); },
    switchByLabel(text, on) {
      const l = [...document.querySelectorAll("label")].find((x) => x.textContent.trim() === text);
      const sw = document.getElementById(l.htmlFor);
      if ((sw.getAttribute("aria-checked") === "true") !== on) sw.click();
    },
    state() {
      const s = document.querySelector('[data-testid="status"]');
      const ext = document.querySelector('[data-testid="ext-status"]');
      return { status: s && s.textContent.trim(), ext: ext && ext.textContent.trim(), theme: document.documentElement.dataset.theme,
        logoPos: getComputedStyle(document.querySelector(".logo-mark__art")).backgroundPosition,
        logoImg: getComputedStyle(document.querySelector(".logo-mark__art")).backgroundImage };
    },
  };`;
const ui = async (expr) => js(`${UI}; return (${expr});`);

/** Ends whatever session is running, so every check starts from an idle app. */
async function ensureIdle() {
  for (const id of ["btn-cancel", "btn-stop"]) {
    const has = await ui(`!!document.querySelector('[data-testid="${id}"]') && !document.querySelector('[data-testid="${id}"]').disabled`);
    if (has) {
      await ui(`(__tw.click("${id}"), 1)`);
      await sleep(600);
    }
  }
  await until(() => ui(`!!document.querySelector('[data-testid="btn-start"]')`), 5000, "idle app");
}

async function prepare(text, { seconds, mistakes = "Medium", minimize = true, countdown = 2, correction = "Mixed" }) {
  await ensureIdle();
  await ui(`(__tw.setText(${JSON.stringify(text)}), 1)`);
  await sleep(300);
  await ui(`(__tw.radio("Where to type", "Into another app"), 1)`);
  await sleep(200);
  await ui(`(__tw.number(__tw.byLabel("Countdown before typing"), ${countdown}), 1)`);
  await ui(`(__tw.switchByLabel("Minimise Typewriter while typing", ${minimize}), 1)`);
  await ui(`(__tw.radio("Set the timing by", "Total duration"), 1)`);
  await sleep(150);
  await ui(`(__tw.number(document.querySelector('[aria-label="Minutes"]'), 0), 1)`);
  await ui(`(__tw.number(document.querySelector('[aria-label="Seconds"]'), ${seconds}), 1)`);
  await ui(`(__tw.radio("Typing mistakes", ${JSON.stringify(mistakes)}), 1)`);
  if (mistakes !== "Off") await ui(`(__tw.radio("How typos get fixed", ${JSON.stringify(correction)}), 1)`);
  await sleep(500);
}
const state = () => ui(`__tw.state()`);
/** Which of these characters currently have a key binding in the X keymap (read with xkbcomp). */
function boundKeysyms(chars) {
  const map = execFileSync("xkbcomp", ["-xkb", DISPLAY, "-"], { env, stdio: ["ignore", "pipe", "ignore"] }).toString();
  const symbols = map.slice(map.indexOf("xkb_symbols"));
  return chars.filter((c) => new RegExp(`\\bU${c.codePointAt(0).toString(16).toUpperCase()}\\b`, "i").test(symbols));
}
const editorText = () => ui(`document.getElementById("source-text").value`);

/** Runs a script in the status window (HUD), then switches WebDriver back to the main window. */
async function inHud(script) {
  const main = await wd("GET", `/session/${sid}/window`);
  const handles = await wd("GET", `/session/${sid}/window/handles`);
  let out;
  for (const h of handles) {
    if (h === main) continue;
    await wd("POST", `/session/${sid}/window`, { handle: h });
    const isHud = await js(`return !!document.querySelector('[data-testid="hud"]')`).catch(() => false);
    if (isHud) {
      out = await js(script);
      break;
    }
  }
  await wd("POST", `/session/${sid}/window`, { handle: main });
  return out;
}
const hudState = () =>
  inHud(`const q = (t) => document.querySelector('[data-testid="' + t + '"]');
    return { phase: q("hud") && q("hud").dataset.phase, label: q("hud-label") && q("hud-label").textContent, detail: q("hud-detail") && q("hud-detail").textContent,
      pct: q("hud-pct") && q("hud-pct").textContent, hint: q("hud-hint") && q("hud-hint").textContent, left: q("hud-left") && q("hud-left").textContent,
      buttons: [...document.querySelectorAll("button")].map((b) => b.dataset.testid) };`);
/** A real mouse click on a status-window button (moves focus to the status window, like a user). */
async function clickHud(testid) {
  const r = await inHud(`const b = document.querySelector('[data-testid="${testid}"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
  assert(r, `status window has no ${testid} button`);
  const id = await windowId("Typewriter status");
  const geo = Object.fromEntries(xdo("getwindowgeometry", "--shell", id).split("\n").map((l) => l.split("=")));
  xdo("mousemove", String(Math.round(Number(geo.X) + r.x)), String(Math.round(Number(geo.Y) + r.y)), "click", "1");
  await sleep(150);
}

// ---------------------------------------------------------------- target windows
let browser, page, other;
const docValue = () => page.evaluate(() => document.getElementById("doc").value);
function windowId(title) {
  return until(() => {
    try {
      return xdo("search", "--onlyvisible", "--name", title).split("\n")[0];
    } catch {
      return null;
    }
  }, 10000, `window "${title}"`);
}
/** The main Typewriter window, restored first if a session minimised it (as the user would). */
async function mainWindow() {
  await js(`return window.__TAURI_INTERNALS__.invoke("show_main")`).catch(() => {});
  return windowId("Typewriter$");
}
async function focusDoc(click = true) {
  const id = await windowId("Target Doc");
  xdo("windowactivate", "--sync", id);
  await sleep(200);
  if (click) {
    // A real click inside the text area, below the text so the caret lands at the end.
    const geo = Object.fromEntries(xdo("getwindowgeometry", "--shell", id).split("\n").map((l) => l.split("=")));
    xdo("mousemove", String(Number(geo.X) + 400), String(Number(geo.Y) + 420), "click", "1");
  }
  await sleep(150);
}
async function resetDoc(title = "Target Doc") {
  await page.evaluate((t) => {
    document.title = t;
    document.getElementById("doc").value = "";
    document.getElementById("pw").value = "";
  }, title);
}

const TRICKY = [
  "Café naïve — 日本語 and emoji 👍 🎉 👨‍👩‍👧‍👦 🇯🇵.",
  "I recieve teh mail evry day; their going tommorow!",
  "\tTabbed line, (parentheses) \"quotes\" 'single' 100% $5 #tag @user.",
  "",
  "Last line with trailing spaces.   ",
].join("\n");

// ---------------------------------------------------------------- run
async function main() {
  assert(existsSync(APP), `App binary not found: ${APP}`);
  console.log(`Typewriter desktop E2E\n  app: ${APP}`);
  bg("Xvfb", [DISPLAY, "-screen", "0", "1600x1000x24", "-nolisten", "tcp"]);
  await sleep(800);
  bg("openbox", ["--sm-disable"]);
  await sleep(800);
  bg("tauri-driver", ["--port", "4444"]);
  await until(() => fetch(`${WD}/status`).then((r) => r.ok).catch(() => false), 15000, "tauri-driver");

  const launch = (x) =>
    chromium.launch({ headless: false, executablePath: CHROMIUM, env, args: [`--window-position=${x},0`, "--window-size=900,700", "--disable-features=Translate", "--no-first-run"] });
  browser = await launch(0);
  page = await (await browser.newContext({ viewport: null })).newPage();
  await page.goto("file://" + join(here, "target.html"));
  const otherBrowser = await launch(950);
  other = await (await otherBrowser.newContext({ viewport: null })).newPage();
  await other.setContent("<title>Other App</title><textarea id=o style='width:90vw;height:60vh'></textarea>");

  await openApp();

  await check("packaged app starts without a dev server, shows its window, clears the splash, and shows the right logo for its theme", async () => {
    await until(() => ui(`!document.getElementById("boot")`), 5000, "launch splash to clear");
    await windowId("Typewriter$"); // visible main window
    const s = await state();
    assert(/logo/.test(s.logoImg), `logo image missing: ${s.logoImg}`);
    const expect = s.theme === "dark" ? "100% 0%" : "0% 0%";
    assert(s.logoPos === expect, `logo half ${s.logoPos} for ${s.theme} theme`);
  });

  await check("theme toggle switches the whole UI and the logo together, repeatedly, and persists after restart", async () => {
    const seen = [];
    for (let i = 0; i < 6; i++) {
      await ui(`(__tw.click("theme-switch"), 1)`);
      await sleep(120);
      const s = await state();
      assert(s.logoPos === (s.theme === "dark" ? "100% 0%" : "0% 0%"), `toggle ${i}: ${s.theme} theme with logo ${s.logoPos}`);
      seen.push(s.theme);
    }
    assert(new Set(seen).size === 2, "theme didn't alternate");
    await ui(`(__tw.click("theme-switch"), 1)`);
    const before = (await state()).theme;
    xdo("windowactivate", "--sync", await mainWindow());
    await sleep(600);
    shot(`desktop-${before}`);
    await ui(`(__tw.click("theme-switch"), 1)`);
    await sleep(600);
    shot(`desktop-${(await state()).theme}`);
    await ui(`(__tw.click("theme-switch"), 1)`);
    await closeApp();
    await openApp();
    const after = await state();
    assert(after.theme === before, `theme after restart ${after.theme}, expected ${before}`);
    assert(after.logoPos === (after.theme === "dark" ? "100% 0%" : "0% 0%"), "logo after restart");
  });

  await check("the window really repaints when the theme changes (pixels, not just DOM)", async () => {
    const id = await mainWindow();
    xdo("windowactivate", "--sync", id);
    await sleep(500);
    const geo = Object.fromEntries(xdo("getwindowgeometry", "--shell", id).split("\n").map((l) => l.split("=")));
    // A point in the sidebar background.
    const px = () => {
      const out = execFileSync("import", ["-window", "root", "-crop", `1x1+${Number(geo.X) + 60}+${Number(geo.Y) + 400}`, "txt:-"], { env }).toString();
      const m = out.match(/#([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})/);
      return m ? (parseInt(m[1], 16) + parseInt(m[2], 16) + parseInt(m[3], 16)) / 3 : -1;
    };
    for (let i = 0; i < 4; i++) {
      const { theme } = await state();
      await sleep(400);
      const lum = px();
      assert(theme === "dark" ? lum < 60 : lum > 200, `window shows luminance ${lum} while the theme is ${theme}`);
      await ui(`(__tw.click("theme-switch"), 1)`);
    }
  });

  await check("nothing is typed after arming while Typewriter still has focus", async () => {
    await resetDoc();
    await prepare("must not appear", { seconds: 3, mistakes: "Off", minimize: false, countdown: 2 });
    const tw = await mainWindow();
    xdo("windowactivate", "--sync", tw);
    await ui(`(__tw.click("btn-start"), 1)`);
    await sleep(4000);
    shot("desktop-arming");
    const s = await state();
    assert(s.status === "Switch to your document", `status ${s.status}`);
    assert((await docValue()) === "", "typed into the document without the user switching");
    const ownText = await ui(`document.getElementById("source-text").value`);
    assert(ownText === "must not appear", "Typewriter's own editor changed");
    await ui(`(__tw.click("btn-cancel"), 1)`);
    await until(async () => (await state()).status === "Stopped", 5000, "cancel");
  });

  await check("Cancel right after Start, while the keyboard is still being prepared, types nothing; the next session types exactly", async () => {
    await resetDoc();
    // Many characters that aren't on the layout, so getting the keyboard ready takes a while.
    const text = "日本語中文한국어Ελληνικάαβγδ→←↑↓∑∏√∞≈≠≤≥ ok";
    await prepare(text, { seconds: 4, mistakes: "Off", minimize: false, countdown: 1 });
    await ui(`(__tw.click("btn-start"), 1)`);
    await until(() => ui(`!!document.querySelector('[data-testid="btn-cancel"]')`), 2000, "Cancel while getting ready");
    await ui(`(__tw.click("btn-cancel"), 1)`);
    await until(async () => (await state()).status === "Stopped", 5000, "stopped");
    await focusDoc();
    await sleep(3500);
    assert((await docValue()) === "", `typed after Cancel: ${JSON.stringify(await docValue())}`);
    assert((await state()).status === "Stopped", "status changed after Cancel");
    await until(async () => boundKeysyms([..."日本語→∑"]).length === 0, 8000, "temporary key bindings removed");
    // The engine is free again: the next session works.
    await resetDoc();
    await ui(`(__tw.click("btn-start"), 1)`);
    await sleep(300);
    await focusDoc();
    await until(async () => (await state()).status === "Sent", 30000, "second session");
    assert((await docValue()) === text, `document differs: ${JSON.stringify(await docValue())}`);
  });

  await check("Cancel and Start again at once: the new session isn't taken over by the cancelled one, and types exactly", async () => {
    await resetDoc();
    const text = "日本語中文한국어Ελληνικάαβγδ→←↑↓∑∏√∞≈≠≤≥ again";
    await prepare(text, { seconds: 4, mistakes: "Off", minimize: false, countdown: 1 });
    await ui(`(__tw.click("btn-start"), 1)`);
    await until(() => ui(`!!document.querySelector('[data-testid="btn-cancel"]')`), 2000, "Cancel while getting ready");
    await ui(`(__tw.click("btn-cancel"), 1)`);
    await until(() => ui(`!!document.querySelector('[data-testid="btn-start"]') && !document.querySelector('[data-testid="btn-start"]').disabled`), 3000, "Start again");
    await ui(`(__tw.click("btn-start"), 1)`);
    // The cancelled session's own "stopped" must not end this one.
    await sleep(1500);
    const s = await state();
    assert(s.status !== "Stopped", `the new session shows "${s.status}": the cancelled session took it over`);
    await focusDoc();
    await until(async () => (await state()).status === "Sent", 30000, "the new session to finish");
    assert((await docValue()) === text, `document differs: ${JSON.stringify(await docValue())}`);
    await until(async () => boundKeysyms([..."日本語→∑"]).length === 0, 8000, "temporary key bindings removed");
  });

  await check("types tricky text into another app with typos, corrections, unicode, tabs and line breaks — exact result", async () => {
    await resetDoc();
    await prepare(TRICKY, { seconds: 20, mistakes: "Medium", correction: "Mixed", minimize: true, countdown: 2 });
    const t0 = Date.now();
    await ui(`(__tw.click("btn-start"), 1)`);
    // Typewriter minimises; the countdown starts as soon as it loses focus.
    await sleep(300);
    await focusDoc();
    // Countdown first: nothing before it ends.
    await until(async () => (await docValue()).length > 0, 8000, "first characters");
    const firstAt = Date.now() - t0;
    assert(firstAt >= 1900, `first key ${firstAt} ms after Start, before the 2 s countdown ended`);
    const early = (await docValue()).length;
    await sleep(3000);
    const mid = (await docValue()).length;
    assert(mid > early && mid < TRICKY.length, `not progressive: ${early} -> ${mid}`);
    shot("desktop-typing");
    await until(async () => (await state()).status === "Sent", 40000, "completion");
    const took = (Date.now() - t0) / 1000;
    const got = await docValue();
    assert(got === TRICKY, `document differs:\n${JSON.stringify(got)}\nexpected\n${JSON.stringify(TRICKY)}`);
    assert(took > 21 && took < 30, `took ${took}s for a 20 s session (+2 s countdown)`);
    const s = await state();
    assert(/hasn't been checked|not checked/.test(s.ext), `must not claim verification: ${s.ext}`);
  });

  await check("long text at a high speed (1,500 characters in 12 s) arrives exactly and on time", async () => {
    await resetDoc();
    const long = "Long passages must arrive intact, even at a brisk pace, with nothing dropped or repeated. ".repeat(17).slice(0, 1500);
    await prepare(long, { seconds: 12, mistakes: "Off", minimize: true, countdown: 2 });
    const t0 = Date.now();
    await ui(`(__tw.click("btn-start"), 1)`);
    await sleep(300);
    await focusDoc();
    await until(async () => (await state()).status === "Sent", 40000, "completion");
    const took = (Date.now() - t0) / 1000;
    const got = await docValue();
    assert(got === long, `long text differs at ${[...got].findIndex((c, i) => c !== long[i])}`);
    assert(took < 17, `took ${took}s for a 12 s session + 2 s countdown`);
  });

  await check("copy-back verification confirms the document text", async () => {
    await focusDoc(false);
    xdo("key", "--clearmodifiers", "ctrl+a");
    xdo("key", "--clearmodifiers", "ctrl+c");
    await sleep(300);
    await ui(`(__tw.click("btn-verify"), 1)`);
    await until(async () => (await state()).status === "Verified", 5000, "verified");
    xdo("windowactivate", "--sync", await mainWindow());
    await sleep(500);
    shot("desktop-verified");
  });

  await check("Smart Humanization on: the humanized copy is typed exactly (typos on); off: the exact original", async () => {
    const { ROBOTIC, ROBOTIC_HUMANIZED } = FIXTURES;
    assert(ROBOTIC && ROBOTIC_HUMANIZED, "fixtures not found");
    const run = async () => {
      await resetDoc();
      await ui(`(__tw.click("btn-start"), 1)`);
      await sleep(300);
      await focusDoc();
      await until(async () => (await state()).status === "Sent", 40000, "completion");
      return docValue();
    };
    await prepare(ROBOTIC, { seconds: 12, mistakes: "Medium", correction: "Mixed", minimize: true, countdown: 2 });
    await ui(`(__tw.switchByLabel("Smart Humanization", true), 1)`);
    await until(async () => (await ui(`document.querySelector('[data-testid="humanize-headline"]')?.textContent`)) === "Humanized automatically", 5000, "automatic humanization");
    let got = await run();
    assert(got === ROBOTIC_HUMANIZED, `humanized copy differs:\n${JSON.stringify(got)}\nexpected\n${JSON.stringify(ROBOTIC_HUMANIZED)}`);
    const kept = await ui(`document.getElementById("source-text").value`);
    assert(kept === ROBOTIC, "the original in the editor changed");

    await ensureIdle();
    await ui(`(__tw.switchByLabel("Smart Humanization", false), 1)`);
    await sleep(300);
    got = await run();
    assert(got === ROBOTIC, `original differs:\n${JSON.stringify(got)}`);
  });

  await check("Caps Lock left on doesn't change the case of what's typed", async () => {
    await resetDoc();
    const text = "MiXeD Case: Hello World, ABC def 123 ÉÀ éà!";
    await prepare(text, { seconds: 5, mistakes: "Off", minimize: true, countdown: 2 });
    await ui(`(__tw.click("btn-start"), 1)`);
    await sleep(300);
    await focusDoc();
    xdo("key", "Caps_Lock");
    try {
      await until(async () => (await state()).status === "Sent", 20000, "completion");
    } finally {
      xdo("key", "Caps_Lock");
    }
    assert((await docValue()) === text, `with Caps Lock: ${JSON.stringify(await docValue())}`);
  });

  await check("focus moving to another app pauses typing; resume continues exactly", async () => {
    await resetDoc();
    const text = "Pausing when you click elsewhere keeps your document safe. ".repeat(2).trim();
    await prepare(text, { seconds: 14, mistakes: "Low", minimize: true, countdown: 2 });
    await ui(`(__tw.click("btn-start"), 1)`);
    await sleep(400);
    await focusDoc();
    await until(async () => (await docValue()).length > 10, 10000, "typing to start");
    // The user clicks into another app.
    xdo("windowactivate", "--sync", await windowId("Other App"));
    await until(async () => (await state()).status === "Paused", 3000, "auto-pause");
    const frozen = await docValue();
    await sleep(1500);
    assert((await docValue()) === frozen, "kept typing after focus left");
    assert((await other.evaluate(() => document.getElementById("o").value)) === "", "typed into the other app");
    const ext = (await state()).ext;
    assert(/Other App/.test(ext), `pause reason not shown: ${ext}`);
    // Resume from Typewriter, then go back to the document (window switch keeps its caret).
    await ui(`(__tw.click("btn-resume"), 1)`);
    await sleep(500);
    await focusDoc(false);
    await until(async () => (await state()).status === "Sent", 30000, "completion after resume");
    assert((await docValue()) === text, `after resume: ${JSON.stringify(await docValue())}`);
  });

  await check("emergency stop shortcut (Ctrl+Shift+Space) stops immediately", async () => {
    await resetDoc();
    await prepare("x".repeat(400), { seconds: 30, mistakes: "Off", minimize: true, countdown: 2 });
    await ui(`(__tw.click("btn-start"), 1)`);
    await sleep(400);
    await focusDoc();
    await until(async () => (await docValue()).length > 5, 10000, "typing");
    xdo("key", "ctrl+shift+space");
    await until(async () => (await state()).status === "Stopped", 3000, "stop");
    const n = (await docValue()).length;
    await sleep(1500);
    assert((await docValue()).length === n, "typing continued after the emergency stop");
    assert(n < 400, "finished instead of stopping");
    assert((await editorText()) === "x".repeat(400), "the source text changed after the emergency stop");
  });

  await check("moving the mouse to the top-left corner stops typing", async () => {
    await resetDoc();
    await prepare("y".repeat(400), { seconds: 30, mistakes: "Off", minimize: true, countdown: 2 });
    await ui(`(__tw.click("btn-start"), 1)`);
    await sleep(400);
    await focusDoc();
    await until(async () => (await docValue()).length > 5, 10000, "typing");
    xdo("mousemove", "0", "0");
    await until(async () => (await state()).status === "Stopped", 3000, "failsafe stop");
    const n = (await docValue()).length;
    await sleep(1000);
    assert((await docValue()).length === n, "typing continued after the failsafe");
    assert((await editorText()) === "y".repeat(400), "the source text changed after the failsafe stop");
    xdo("mousemove", "700", "500"); // leave the corner, or the next session would stop at once
  });

  await check("refuses to type into a login window", async () => {
    await resetDoc("Sign in - Accounts");
    await prepare("secret words", { seconds: 4, mistakes: "Off", minimize: true, countdown: 2 });
    await ui(`(__tw.click("btn-start"), 1)`);
    await sleep(400);
    const login = await windowId("Sign in - Accounts");
    xdo("windowactivate", "--sync", login);
    // The user clicks into the sign-in page (a window that only got focus by itself, right
    // after Start, doesn't start the countdown).
    const lg = Object.fromEntries(xdo("getwindowgeometry", "--shell", login).split("\n").map((l) => l.split("=")));
    xdo("mousemove", String(Number(lg.X) + 400), String(Number(lg.Y) + 420), "click", "1");
    try {
      await until(async () => (await state()).status === "Paused", 8000, "refusal");
    } catch (e) {
      throw new Error(`${e.message}; app state ${JSON.stringify(await state())}; doc ${JSON.stringify(await docValue())}; active window "${xdo("getactivewindow", "getwindowname")}"`);
    }
    await sleep(1000);
    assert((await docValue()) === "", "typed into a login window");
    assert(/login|password/i.test((await state()).ext), "no explanation shown");
    await ui(`(__tw.click("btn-stop"), 1)`);
    await until(async () => (await state()).status === "Stopped", 3000, "stop");
  });

  await check("punctuation, spacing and Unicode edge cases arrive exactly (typos on)", async () => {
    await resetDoc();
    const text = [
      "“Smart” ‘quotes’ — em – en … ellipsis; NBSP:\u00a0| two  spaces  |\ttab\tin line",
      "Backslash \\ braces {} [] <> | ~ ^ ` %s $(echo hi) <b>not bold</b> 50% off #1 @me",
      "e\u0301 combining, Straße, İstanbul, Ελληνικά, 中文, 👍🏽 🇯🇵",
      "",
      "End.",
    ].join("\n");
    await prepare(text, { seconds: 16, mistakes: "Medium", correction: "Mixed", minimize: true, countdown: 2 });
    await ui(`(__tw.click("btn-start"), 1)`);
    await sleep(300);
    await focusDoc();
    await until(async () => (await state()).status === "Sent", 40000, "completion");
    const got = await docValue();
    assert(got === text, `document differs:\n${JSON.stringify(got)}\nexpected\n${JSON.stringify(text)}`);
    assert((await editorText()) === text, "the source text changed");
  });

  await check("many different characters that aren't on the keyboard layout arrive exactly (key remapping stress)", async () => {
    await resetDoc();
    // More distinct off-layout symbols than there are spare key codes, so bindings are reused.
    const symbols = "日本語中文한국어Ελληνικάαβγδ→←↑↓∑∏√∞≈≠≤≥“”‘’—–…•€£¥©®™👍🏽🎉🚀🌍❤️😀😂🤖🧪📦🔥✨🌟💡⚡";
    const text = [...new Intl.Segmenter().segment(symbols)].map((g) => g.segment).join(" ") + "\nok";
    await prepare(text, { seconds: 14, mistakes: "Off", minimize: true, countdown: 2 });
    await ui(`(__tw.click("btn-start"), 1)`);
    await sleep(300);
    await focusDoc();
    await until(async () => (await state()).status === "Sent", 60000, "completion");
    const got = await docValue();
    assert(got === text, `document differs:\n${JSON.stringify(got)}\nexpected\n${JSON.stringify(text)}`);
  });

  await check("back-to-back sessions never mix up characters (the second starts while the first is still cleaning up)", async () => {
    // More distinct off-layout symbols than spare key codes, so the first session reuses
    // codes; the second needs the same symbols and starts while the first is cleaning up.
    const symbols = [..."“”‘’—–…Ελληνικάβγδ中文日本語한국어→←≈∞≠≤≥✓¥€"];
    const first = symbols.join("");
    const second = [...symbols].reverse().join("") + " ok";
    await resetDoc();
    await prepare(first, { seconds: 4, mistakes: "Off", minimize: false, countdown: 2 });
    await ui(`(__tw.click("btn-start"), 1)`);
    await sleep(300);
    await focusDoc();
    await until(async () => (await state()).status === "Sent", 30000, "first session");
    assert((await docValue()) === first, `first: ${JSON.stringify(await docValue())}`);
    // Start the next one at once, as with "Type again", while the document keeps focus.
    await page.evaluate(() => {
      document.getElementById("doc").value = "";
    });
    await ui(`(__tw.setText(${JSON.stringify(second)}), 1)`);
    await sleep(150);
    await ui(`(__tw.click("btn-start"), 1)`);
    // The document already has focus; the user's click into it starts the countdown.
    await sleep(300);
    await focusDoc();
    try {
      await until(async () => (await state()).status === "Sent", 30000, "second session");
    } catch (e) {
      throw new Error(`${e.message}; state ${JSON.stringify(await state())}; doc ${JSON.stringify(await docValue())}; active "${xdo("getactivewindow", "getwindowname")}"`);
    }
    assert((await docValue()) === second, `second: ${JSON.stringify(await docValue())}`);
  });

  await check("status window: shows progress, time left and the stop shortcut; its Pause, Resume and Stop work with real clicks", async () => {
    await resetDoc();
    const text = "The status window controls a session without opening Typewriter. ".repeat(3).trim();
    await prepare(text, { seconds: 20, mistakes: "Off", minimize: true, countdown: 2 });
    await ui(`(__tw.click("btn-start"), 1)`);
    await sleep(400);
    await focusDoc();
    await until(async () => (await docValue()).length > 8, 10000, "typing");
    const h = await until(async () => {
      const v = await hudState();
      return v && v.phase === "typing" && v.pct ? v : null;
    }, 5000, "status window in the typing state");
    assert(/\d+%/.test(h.pct), `no percentage: ${h.pct}`);
    assert(/\d:\d\d left/.test(h.left), `time left: ${h.left}`);
    assert(/Ctrl\+Shift\+Space/.test(h.hint), `hint: ${h.hint}`);
    assert(h.buttons.includes("hud-pause") && h.buttons.includes("hud-stop"), `buttons: ${h.buttons}`);
    shot("desktop-hud-typing");
    // Pause from the status window.
    await clickHud("hud-pause");
    await until(async () => (await state()).status === "Paused", 3000, "pause from the status window");
    const frozen = await docValue();
    await sleep(1200);
    assert((await docValue()) === frozen, "kept typing while paused");
    const hp = await hudState();
    assert(hp.phase === "paused" && hp.buttons.includes("hud-resume"), `paused status window: ${JSON.stringify(hp)}`);
    shot("desktop-hud-paused");
    // Resume from the status window, then click back into the document.
    await clickHud("hud-resume");
    await sleep(400);
    await focusDoc(false);
    await until(async () => (await docValue()).length > frozen.length, 10000, "typing to continue after resume");
    // Stop from the status window.
    await clickHud("hud-stop");
    await until(async () => (await state()).status === "Stopped", 3000, "stop from the status window");
    const n = (await docValue()).length;
    await sleep(1200);
    assert((await docValue()).length === n && n < text.length, "typing continued after Stop");
    assert(text.startsWith(await docValue()), "the document holds something other than the start of the text");
    assert((await editorText()) === text, "the source text changed");
    const hs = await hudState();
    assert(hs.phase === "stopped" && hs.buttons.includes("hud-open"), `stopped status window: ${JSON.stringify(hs)}`);
  });

  await check("in-app preview still works in the desktop app", async () => {
    await resetDoc();
    xdo("windowactivate", "--sync", await mainWindow());
    await ui(`(__tw.radio("Where to type", "Preview here"), 1)`);
    await ui(`(__tw.setText("Preview check."), 1)`);
    await ui(`(__tw.radio("Set the timing by", "Total duration"), 1)`);
    await sleep(150);
    await ui(`(__tw.number(document.querySelector('[aria-label="Minutes"]'), 0), 1)`);
    await ui(`(__tw.number(document.querySelector('[aria-label="Seconds"]'), 3), 1)`);
    await sleep(400);
    await ui(`(__tw.click("btn-start"), 1)`);
    await until(async () => (await state()).status === "Complete", 20000, "preview completion");
    assert((await ui(`document.querySelector('[data-testid="playback-text"]').textContent`)) === "Preview check.", "preview output");
    assert((await docValue()) === "", "preview typed into another app");
  });

  await check("closing with unsaved text asks first; Keep keeps the app and the text", async () => {
    await ui(`(__tw.radio("Where to type", "Preview here"), 1)`);
    await ui(`(__tw.setText("Unsaved words that must not vanish."), 1)`);
    await sleep(500);
    const id = await mainWindow();
    xdo("windowactivate", "--sync", id);
    xdo("key", "--clearmodifiers", "alt+F4");
    await until(() => ui(`!!document.querySelector('[data-testid="quit-dialog"]')?.open`), 5000, "quit confirmation");
    assert(await ui(`!!document.querySelector('[data-testid="quit-unsaved"]')`), "no unsaved-text warning");
    shot("desktop-quit-dialog");
    await ui(`(__tw.click("quit-keep"), 1)`);
    await sleep(800);
    assert(!(await ui(`document.querySelector('[data-testid="quit-dialog"]').open`)), "dialog still open");
    assert((await editorText()) === "Unsaved words that must not vanish.", "text lost");
    await mainWindow(); // still running
  });

  await check("quitting mid-session asks, ends the session, restores the keymap and exits", async () => {
    await resetDoc();
    // Off-layout characters get temporary key bindings when the session starts; quitting
    // must still remove every one of them (the typing thread must finish its cleanup).
    const special = [..."日本語中文한국어→≈∞🚀"];
    await prepare(special.join("") + " " + "z".repeat(400), { seconds: 40, mistakes: "Off", minimize: false, countdown: 2 });
    await ui(`(__tw.click("btn-start"), 1)`);
    await sleep(300);
    await focusDoc();
    await until(async () => (await docValue()).length > 5, 15000, "typing");
    const boundNow = boundKeysyms(special);
    assert(boundNow.length > 0, "precondition: the session should have bound off-layout characters");
    // Clicking Typewriter to close it moves focus there, which already pauses typing; quitting must end the session.
    const id = await mainWindow();
    const appPid = xdo("getwindowpid", id);
    xdo("windowactivate", "--sync", id);
    xdo("key", "--clearmodifiers", "alt+F4");
    await until(() => ui(`!!document.querySelector('[data-testid="quit-dialog"]')?.open`), 5000, "quit confirmation");
    assert(await ui(`!!document.querySelector('[data-testid="quit-running"]')`), "no running-session warning");
    await ui(`(__tw.click("quit-confirm"), 1)`).catch(() => {}); // the window goes away mid-call
    await until(() => {
      try {
        xdo("search", "--name", "^Typewriter");
        return false;
      } catch {
        return true;
      }
    }, 15000, "Typewriter windows to close");
    // The process stays only as long as it needs to stop typing and restore the keymap.
    await until(() => !existsSync(`/proc/${appPid}`), 15000, "the Typewriter process to exit");
    const n = (await docValue()).length;
    await sleep(1000);
    assert((await docValue()).length === n && n < 400, "typing continued after quitting");
    const left = boundKeysyms(special);
    assert(left.length === 0, `temporary key bindings left in the keymap after quitting: ${left.join(" ")}`);
    sid = null;
  });

  /** Asks the window manager to close a window, like the taskbar's "Close window" (works on minimized windows). */
  const wmClose = (id) => execFileSync("wmctrl", ["-i", "-c", `0x${Number(id).toString(16)}`], { env });
  const hidden = (id) => /_NET_WM_STATE_HIDDEN/.test(execFileSync("xprop", ["-id", id, "_NET_WM_STATE"], { env }).toString());
  const appGone = (pid) => () => !existsSync(`/proc/${pid}`);
  /** A fresh tauri-driver, after the previous app process has exited. */
  const restartDriver = async () => {
    for (const p of procs.filter((p) => p.spawnargs[0] === "tauri-driver")) p.kill("SIGTERM");
    await sleep(800);
    bg("tauri-driver", ["--port", "4444"]);
    await until(() => fetch(`${WD}/status`).then((r) => r.ok).catch(() => false), 15000, "tauri-driver");
  };

  await check("closing while minimized (as from the taskbar) brings the window back with the question; Quit exits", async () => {
    await restartDriver();
    await openApp();
    await ui(`(__tw.setText("Unsaved words."), 1)`);
    await sleep(400);
    const id = await mainWindow();
    const appPid = xdo("getwindowpid", id);
    xdo("windowminimize", "--sync", id);
    await until(() => hidden(id), 5000, "the window to be minimized");
    wmClose(id);
    await until(() => ui(`!!document.querySelector('[data-testid="quit-dialog"]')?.open`), 5000, "quit confirmation");
    await until(() => !hidden(id), 5000, "the window to come back from minimized, so the question can be seen");
    shot("desktop-quit-from-minimized");
    await ui(`(__tw.click("quit-confirm"), 1)`).catch(() => {});
    await until(appGone(appPid), 15000, "the Typewriter process to exit");
    sid = null;
  });

  await check("a page that doesn't answer can't keep Typewriter open: closing still exits", async () => {
    await restartDriver();
    await openApp();
    await ui(`(__tw.setText("Unsaved words."), 1)`);
    await sleep(400);
    const id = await mainWindow();
    const appPid = xdo("getwindowpid", id);
    // Hang the page's JavaScript for good, as a blank or frozen window would be.
    await js(`setTimeout(() => { for (;;) {} }, 50); return 1;`);
    await sleep(500);
    const t0 = Date.now();
    wmClose(id);
    await until(appGone(appPid), 15000, "the Typewriter process to exit although its page is hung");
    console.log(`    exited ${((Date.now() - t0) / 1000).toFixed(1)} s after the close request`);
    sid = null;
  });

  await check("on a Wayland session it explains the limit and won't start typing into other apps", async () => {
    for (const p of procs.filter((p) => p.spawnargs[0] === "tauri-driver")) p.kill("SIGTERM");
    await sleep(800);
    // GTK still draws on Xvfb (GDK_BACKEND=x11); the native check sees a Wayland session.
    bg("tauri-driver", ["--port", "4444"], { env: { ...env, WAYLAND_DISPLAY: "wayland-0" } });
    await until(() => fetch(`${WD}/status`).then((r) => r.ok).catch(() => false), 15000, "tauri-driver");
    await openApp();
    await ui(`(__tw.setText("Wayland check."), 1)`);
    await ui(`(__tw.radio("Where to type", "Into another app"), 1)`);
    // Wait past the interim "Checking…" for the real answer.
    const msg = await until(async () => {
      const t = await ui(`document.querySelector('[data-testid="ext-support"]')?.textContent`);
      return t && !/Checking/.test(t) ? t : null;
    }, 8000, "support message");
    assert(/Wayland/.test(msg) && /Xorg/.test(msg), `message: ${msg}`);
    assert(await ui(`document.querySelector('[data-testid="btn-start"]').disabled`), "Start is enabled on Wayland");
    await until(async () => (await state()).status === "Ready", 5000, "the status to show Ready (the text is there)");
    shot("desktop-wayland");
    await ui(`(__tw.setText(""), 1)`);
    await closeApp();
  });

  await closeApp();
  await browser.close();
  await otherBrowser.close();
}

main()
  .catch((e) => {
    failures++;
    console.error(e);
  })
  .finally(() => {
    for (const p of procs.reverse()) p.kill("SIGTERM");
    const passed = results.filter((r) => r.ok).length;
    console.log(`\n${passed} passed, ${results.length - passed} failed`);
    process.exit(failures ? 1 : 0);
  });
