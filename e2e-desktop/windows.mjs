/**
 * Windows end-to-end test: the real Typewriter.exe types into a real native Windows
 * text window with real key events (SendInput), on a real Windows desktop.
 *
 *   tauri-driver + msedgedriver   operate Typewriter's own UI (main window and status window)
 *   e2e-desktop/win/target.ps1    the destination: a native Win32 text box that saves its text
 *   e2e-desktop/win/input.ps1     the user's real mouse clicks and shortcut presses, and screenshots
 *
 * Nothing in Typewriter's input path is mocked.
 *
 * Usage: node e2e-desktop/windows.mjs [path\to\typewriter.exe]
 * Needs: tauri-driver and msedgedriver on PATH (see .github/workflows/desktop.yml).
 * SHOTS=<dir> saves screenshots of the real screen.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const APP = resolve(process.argv[2] ?? join(here, "../src-tauri/target/release/typewriter.exe"));
const SHOTS = process.env.SHOTS ? resolve(process.env.SHOTS) : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const work = mkdtempSync(join(tmpdir(), "tw-win-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
let failures = 0;
let aborted = false;

function ps(script, ...args) {
  return execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(here, "win", script), ...args.map(String)], { timeout: 30000 })
    .toString()
    .trim();
}
function shot(name) {
  if (!SHOTS) return;
  try {
    ps("input.ps1", "shot", join(SHOTS, `${name}.png`));
    console.log(`    screenshot: ${name}.png`);
  } catch (e) {
    console.log(`    (screenshot ${name} failed: ${e.message.split("\n")[0]})`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
async function until(fn, timeoutMs, what) {
  const t0 = Date.now();
  let last;
  let err = null;
  while (Date.now() - t0 < timeoutMs) {
    last = await fn().catch((e) => ((err = e), null));
    if (last) return last;
    await sleep(150);
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}${err ? ` (last error: ${String(err.message ?? err).split("\n")[0]})` : ""}`);
}
async function check(name, fn) {
  if (aborted) {
    failures++;
    console.log(`  ✘ ${name}\n    skipped: the app stopped responding in an earlier check`);
    return;
  }
  if (process.env.ONLY && !new RegExp(process.env.ONLY).test(name)) return;
  const t0 = Date.now();
  try {
    await fn();
    console.log(`  ✓ ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    failures++;
    console.log(`  ✘ ${name}\n    ${String(e?.message ?? e).split("\n").join("\n    ")}`);
    await diagnose();
    shot(`win-failed-${failures}`);
  }
}

/** What the app, the status window and Windows report after a failure, so a CI log alone explains it. */
async function diagnose() {
  const lines = [];
  const add = async (label, fn) => {
    try {
      lines.push(`${label}: ${JSON.stringify(await fn())}`);
    } catch (e) {
      lines.push(`${label}: (unavailable: ${String(e?.message ?? e).split("\n")[0]})`);
    }
  };
  if (sid) {
    await add("app", () => ui(`__tw.state()`, 5000));
    await add("status window", () => hud());
  }
  await add("foreground window", () => ps("input.ps1", "fg"));
  for (const key of Object.keys(targets)) await add(`${key} text`, () => read(key));
  console.log(`    diagnostics:\n      ${lines.join("\n      ")}`);
}

// ---------------------------------------------------------------- WebDriver
const WD = "http://127.0.0.1:4444";
let sid = null;
let mainHandle = null;
/** Every call is bounded: a frozen app must fail the test, not hang it. */
async function wd(method, path, body, timeoutMs = 15000) {
  let r;
  try {
    r = await fetch(`${WD}${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if (e.name === "TimeoutError") throw new Error(`Typewriter didn't respond within ${timeoutMs / 1000} s (WebDriver ${path}): its UI is frozen`);
    throw e;
  }
  const j = await r.json();
  if (j.value && j.value.error) throw new Error(`WebDriver ${path}: ${j.value.error} ${j.value.message}`);
  return j.value;
}
const js = (script, timeoutMs) => wd("POST", `/session/${sid}/execute/sync`, { script, args: [] }, timeoutMs);
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
    has(testid) { const b = document.querySelector('[data-testid="' + testid + '"]'); return !!b && !b.disabled; },
    state() {
      const q = (t) => document.querySelector('[data-testid="' + t + '"]');
      return { status: q("status") && q("status").textContent.trim(), ext: q("ext-status") && q("ext-status").textContent.trim(),
        phase: q("ext-status") && q("ext-status").dataset.phase };
    },
  };`;
const ui = (expr, timeoutMs) => js(`${UI}; return (${expr});`, timeoutMs);

async function inHud(script) {
  const handles = await wd("GET", `/session/${sid}/window/handles`);
  let out = null;
  for (const h of handles) {
    if (h === mainHandle) continue;
    await wd("POST", `/session/${sid}/window`, { handle: h });
    if (await js(`return !!document.querySelector('[data-testid="hud"]')`).catch(() => false)) {
      out = await js(script);
      break;
    }
  }
  await wd("POST", `/session/${sid}/window`, { handle: mainHandle });
  return out;
}
const hud = () =>
  inHud(`const q = (t) => document.querySelector('[data-testid="' + t + '"]');
    return { phase: q("hud").dataset.phase, label: q("hud-label") ? q("hud-label").textContent : "", detail: q("hud-detail") ? q("hud-detail").textContent : "",
      buttons: [...document.querySelectorAll("button")].map((b) => b.dataset.testid), text: document.body.innerText.trim() };`);
const hudClick = (testid) => inHud(`document.querySelector('[data-testid="${testid}"]').click(); return 1;`);

// ---------------------------------------------------------------- target windows
const targets = {};
async function openTarget(key, title, x, y) {
  const out = join(work, `${key}.txt`);
  writeFileSync(out, "");
  const log = [];
  const p = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(here, "win", "target.ps1"), "-Out", out, "-Title", title, "-X", String(x), "-Y", String(y)], { stdio: ["ignore", "pipe", "pipe"] });
  p.stdout.on("data", (d) => log.push(String(d)));
  p.stderr.on("data", (d) => log.push(String(d)));
  p.on("exit", (code) => log.push(`(exited with code ${code})`));
  procs.push(p);
  const rect = await until(async () => ps("input.ps1", "find", title) || null, 20000, `the "${title}" window`).catch((e) => {
    shot(`win-00-no-${key}-window`);
    throw new Error(`${e.message}\n    target.ps1 output: ${log.join("").trim() || "(none)"}`);
  });
  const [rx, ry, rw, rh] = rect.split(" ").map(Number);
  targets[key] = { out, title, x: rx, y: ry, w: rw, h: rh };
}
const read = (key) => readFileSync(targets[key].out, "utf8").replace(/\r\n/g, "\n");
async function clear(key) {
  writeFileSync(`${targets[key].out}.clear`, "");
  await until(async () => !existsSync(`${targets[key].out}.clear`) && read(key) === "", 5000, `${key} to clear`);
}
/** A real click inside the target's text box, near the bottom so the caret lands at the end. */
async function clickInto(key) {
  const t = targets[key];
  const hidden = ps("input.ps1", "hideconsoles");
  if (hidden) console.log(`    ${hidden.split("\n").join("\n    ")}`);
  ps("input.ps1", "click", Math.round(t.x + t.w / 2), Math.round(t.y + t.h - 60));
  // The test is only meaningful if the click really chose the target window.
  await until(async () => ps("input.ps1", "fg") === t.title, 3000, `the "${t.title}" window to have focus after the click`).catch((e) => {
    throw new Error(`${e.message}; the click chose "${ps("input.ps1", "fg")}" instead`);
  });
}

// ---------------------------------------------------------------- sessions
async function ensureIdle() {
  for (const id of ["btn-cancel", "btn-stop"]) {
    if (await ui(`__tw.has("${id}")`)) {
      await ui(`(__tw.click("${id}"), 1)`);
      await sleep(800);
    }
  }
  await js(`return window.__TAURI_INTERNALS__.invoke("show_main")`).catch(() => {});
  // Start exists (it stays disabled until there is text).
  await until(() => ui(`!!document.querySelector('[data-testid="btn-start"]')`), 8000, "an idle app");
}
async function configure(text, { seconds, mistakes = "Medium", countdown = 3 }) {
  await ensureIdle();
  await ui(`(__tw.setText(${JSON.stringify(text)}), 1)`);
  await sleep(300);
  await ui(`(__tw.radio("Where to type", "Into another app"), 1)`);
  await sleep(300);
  await ui(`(__tw.number(__tw.byLabel("Countdown before typing"), ${countdown}), 1)`);
  await ui(`(__tw.radio("Set the timing by", "Total duration"), 1)`);
  await sleep(150);
  await ui(`(__tw.number(document.querySelector('[aria-label="Minutes"]'), 0), 1)`);
  await ui(`(__tw.number(document.querySelector('[aria-label="Seconds"]'), ${seconds}), 1)`);
  await ui(`(__tw.radio("Typing mistakes", ${JSON.stringify(mistakes)}), 1)`);
  if (mistakes !== "Off") await ui(`(__tw.radio("How typos get fixed", "Mixed"), 1)`);
  await until(() => ui(`__tw.has("btn-start")`), 5000, "Start to be enabled");
}
/** Presses "Type into app". On a frozen app this is where the test fails. */
async function start() {
  await ui(`(__tw.click("btn-start"), 1)`);
  // The app must answer straight away and show a live status window.
  const h = await until(async () => {
    const v = await hud();
    return v && v.label ? v : null;
  }, 15000, "the status window to show its controls");
  return h;
}
const hudPhase = async () => (await hud())?.phase;

const TRICKY = [
  "Café naïve — 日本語 and emoji 👍 🎉 🇯🇵.",
  "I recieve teh mail evry day; their going tommorow!",
  "\tTabbed line, (parentheses) \"quotes\" 'single' 100% $5 #tag @user.",
  "",
  "Last line with trailing spaces.   ",
].join("\n");

// ---------------------------------------------------------------- run
async function main() {
  assert(existsSync(APP), `App not found: ${APP}`);
  console.log(`Typewriter Windows E2E\n  app: ${APP}`);
  procs.push(spawn("tauri-driver", ["--port", "4444"], { stdio: "ignore" }));
  await until(() => fetch(`${WD}/status`).then((r) => r.ok), 20000, "tauri-driver");
  await openTarget("doc", "Target Notes", 40, 260);
  await openTarget("other", "Other Window", 620, 420);

  await check("launches and shows Typewriter's UI", async () => {
    const v = await wd("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application: APP } } } }, 60000);
    sid = v.sessionId;
    mainHandle = await wd("GET", `/session/${sid}/window`);
    await until(() => js(`return !!document.querySelector('[data-testid="btn-start"]') && !document.getElementById("boot")`), 30000, "the UI");
    shot("win-01-launched");
  });

  await check("Type into app answers at once and the status window shows its controls (not blank)", async () => {
    await configure("Status window check.", { seconds: 4, mistakes: "Off", countdown: 5 });
    let h;
    try {
      h = await start();
    } catch (e) {
      shot("win-02-after-start-FAILED");
      aborted = /frozen|Timed out/.test(e.message);
      throw e;
    }
    shot("win-02-status-window");
    assert(/Stop/.test(h.text), `status window has no Stop control: ${JSON.stringify(h)}`);
    // Nothing may be typed while Typewriter itself still has focus or before the countdown ends.
    await ui(`(__tw.has("btn-cancel") ? __tw.click("btn-cancel") : __tw.has("btn-stop") && __tw.click("btn-stop"), 1)`);
    await until(async () => ["stopped", "completed", "failed"].includes(await hudPhase()), 8000, "the session to end after Stop");
    assert(read("doc") === "", `text arrived although the session was stopped before the target was chosen: ${JSON.stringify(read("doc"))}`);
  });

  await check("types tricky text into a real Windows app, exactly, with typos corrected", async () => {
    await clear("doc");
    await configure(TRICKY, { seconds: 20, mistakes: "Medium" });
    await start();
    await clickInto("doc");
    await until(async () => (await hudPhase()) === "typing", 15000, "typing to begin");
    await until(async () => read("doc").length > 20, 15000, "characters to arrive in the target");
    shot("win-03-typing");
    await until(async () => (await hudPhase()) === "completed", 90000, "the session to complete");
    await sleep(500);
    shot("win-04-completed");
    const got = read("doc");
    assert(got === TRICKY, `final text differs.\n    want ${JSON.stringify(TRICKY)}\n    got  ${JSON.stringify(got)}`);
  });

  await check("pause and resume from the status window, then finishes exactly", async () => {
    await clear("doc");
    const text = "Pause and resume on Windows: nothing lost, nothing repeated. ".repeat(3).trim();
    await configure(text, { seconds: 14, mistakes: "Off" });
    await start();
    await clickInto("doc");
    await until(async () => read("doc").length > 15, 20000, "typing to begin");
    await hudClick("hud-pause");
    await until(async () => (await hudPhase()) === "paused", 5000, "paused");
    const atPause = read("doc");
    await sleep(1500);
    assert(read("doc") === atPause, "text kept arriving while paused");
    shot("win-05-paused");
    await hudClick("hud-resume");
    await sleep(500);
    await clickInto("doc");
    await until(async () => (await hudPhase()) === "completed", 60000, "the session to complete after resuming");
    await sleep(400);
    assert(read("doc") === text, `final text differs after pause/resume: ${JSON.stringify(read("doc"))}`);
  });

  await check("clicking another window pauses typing, and nothing goes into that window", async () => {
    await clear("doc");
    await clear("other");
    await configure("Focus check. ".repeat(12).trim(), { seconds: 12, mistakes: "Off" });
    await start();
    await clickInto("doc");
    await until(async () => read("doc").length > 10, 20000, "typing to begin");
    await clickInto("other");
    await until(async () => (await hud())?.phase === "paused", 5000, "a focus pause");
    const h = await hud();
    shot("win-06-focus-pause");
    await sleep(1200);
    assert(read("other") === "", `keys went into the other window: ${JSON.stringify(read("other"))}`);
    assert(/Focus moved|paused/i.test(h.detail), `pause reason not shown: ${JSON.stringify(h)}`);
    await hudClick("hud-stop");
    await until(async () => (await hudPhase()) === "stopped", 5000, "stopped");
  });

  await check("emergency stop (Ctrl+Shift+Space) stops typing at once", async () => {
    await clear("doc");
    await configure("Emergency stop check. ".repeat(20).trim(), { seconds: 20, mistakes: "Off" });
    await start();
    await clickInto("doc");
    await until(async () => read("doc").length > 10, 20000, "typing to begin");
    ps("input.ps1", "stopkeys");
    await until(async () => (await hudPhase()) === "stopped", 3000, "the emergency stop");
    const atStop = read("doc");
    await sleep(1500);
    assert(read("doc") === atStop, "text kept arriving after the emergency stop");
    shot("win-07-emergency-stop");
  });

  if (sid) await wd("DELETE", `/session/${sid}`).catch(() => {});
}

main()
  .catch((e) => {
    failures++;
    console.error(e);
  })
  .finally(() => {
    for (const p of procs.reverse()) p.kill();
    try {
      execFileSync("taskkill", ["/IM", "typewriter.exe", "/F"], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
    console.log(failures ? `\n${failures} failed` : "\nall passed");
    process.exit(failures ? 1 : 0);
  });
