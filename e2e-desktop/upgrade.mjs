/**
 * Upgrade check: the settings a user saved in the installed version survive installing the new
 * version over it.
 *
 *   node e2e-desktop/upgrade.mjs before <app> <state.json>   in the old version: change settings, then close (SETTLE_MS later)
 *   node e2e-desktop/upgrade.mjs check <app> <state.json>    the old version again: they were really saved
 *   node e2e-desktop/upgrade.mjs control <app> <state.json>  like check, for an old version that may lose some of
 *                                                            its own changes: the keys it lost are dropped from
 *                                                            state.json, and "after" checks the rest
 *   (install the new version over the old one)
 *   node e2e-desktop/upgrade.mjs after <app> <state.json>    in the new version: every saved setting is still there
 *
 * Each run ends by closing the app the way a user does (the title bar's X; Alt+F4 on Linux) and
 * waits for it to exit by itself: ending the WebDriver session kills the process, which can lose
 * storage writes that weren't flushed yet. "check" tells "not saved" apart from "lost by the upgrade".
 *
 * Linux: runs on its own Xvfb display (:98) and uses $HOME as the user. Windows: the current user.
 * Needs tauri-driver (and msedgedriver on Windows) on PATH.
 *
 * Windows: WebDriver can't be used here. msedgedriver runs the app's WebView2 in a temporary
 * profile, even with --user-data-dir in the browser arguments (runs 36–44: the real profile was
 * never written by a session, so every key the check changed was "lost"). Instead the app is
 * started the way a user starts it, with only a remote-debugging port added
 * (WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS), and Playwright attaches to it over CDP. Each run
 * fails if the app's own profile wasn't written.
 */
import { execFileSync, spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const [mode, app, stateFile] = process.argv.slice(2);
const linux = process.platform === "linux";
const env = linux ? { ...process.env, DISPLAY: ":98", GDK_BACKEND: "x11", XDG_SESSION_TYPE: "x11" } : process.env;
/** The app's own WebView2 profile (Tauri: <local app data>/<identifier>/EBWebView). */
const PROFILE = linux ? null : join(process.env.LOCALAPPDATA, "app.typewriter.desktop", "EBWebView");
/** The newest change to page storage in the app's profile, in ms (0 if none). */
function storageWritten() {
  const dir = join(PROFILE, "Default", "Local Storage");
  try {
    const files = readdirSync(dir, { recursive: true }).map((f) => statSync(join(dir, f))).filter((st) => st.isFile());
    return Math.max(0, ...files.map((st) => st.mtimeMs));
  } catch {
    return 0;
  }
}
const procs = [];
const bg = (c, a) => { const p = spawn(c, a, { env, stdio: "ignore" }); procs.push(p); return p; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WD = "http://127.0.0.1:4455";
async function wd(m, p, b) {
  const r = await fetch(WD + p, { method: m, headers: { "content-type": "application/json" }, body: b ? JSON.stringify(b) : undefined });
  const j = await r.json();
  if (j.value && j.value.error) throw new Error(`${p}: ${j.value.error} ${j.value.message}`);
  return j.value;
}
const here = dirname(fileURLToPath(import.meta.url));
const running = () =>
  linux
    ? (() => { try { execFileSync("pgrep", ["-x", "typewriter"]); return true; } catch { return false; } })()
    : /typewriter\.exe/i.test(execFileSync("tasklist", ["/FI", "IMAGENAME eq typewriter.exe", "/NH"]).toString());
/** Closes the main window like a user (its X button / Alt+F4) and waits for the app to exit by itself. */
async function closeLikeUser() {
  if (linux) {
    const id = execFileSync("xdotool", ["search", "--name", "^Typewriter$"], { env }).toString().trim().split("\n").pop();
    execFileSync("xdotool", ["windowactivate", "--sync", id], { env });
    execFileSync("xdotool", ["key", "--clearmodifiers", "alt+F4"], { env });
  } else {
    execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(here, "win", "input.ps1"), "sysclose", "Typewriter"]);
  }
  await until(() => !running(), 20000, "Typewriter to exit after its window was closed");
}
async function until(fn, ms, what) { const t = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch {} if (Date.now() - t > ms) throw new Error("timed out: " + what); await sleep(200); } }
if (linux) {
  bg("Xvfb", [":98", "-screen", "0", "1600x1000x24", "-nolisten", "tcp"]);
  await sleep(800);
  bg("openbox", ["--sm-disable"]);
  bg("tauri-driver", ["--port", "4455", "--native-port", "4456"]); // away from the harness defaults (4444, 4445)
  await until(() => fetch(WD + "/status").then((r) => r.ok), 15000, "tauri-driver");
}
/**
 * Windows: starts the app like a user (its own WebView2 profile), with a remote-debugging port,
 * and attaches Playwright to its main window. Returns a function that runs a script body there.
 */
let cdp = null;
async function attach() {
  const port = 9333;
  // Detached: the app must outlive nothing here, and closing it is up to closeLikeUser.
  spawn(app, [], { env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }, stdio: "ignore", detached: true }).unref();
  const { chromium } = await import("@playwright/test");
  const browser = (cdp = await until(() => chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 5000 }), 60000, "the app's WebView2 to accept a CDP connection"));
  const main = await until(async () => {
    for (const p of browser.contexts().flatMap((c) => c.pages())) if (!/hud\.html/.test(p.url()) && (await p.evaluate(() => !!document.getElementById("root")).catch(() => false))) return p;
  }, 30000, "the main window's page");
  // A string is evaluated by CDP itself (the page's CSP has no 'unsafe-eval' for new Function).
  return (body) => main.evaluate(`(() => { ${body} })()`);
}
let sid;
const started = Date.now();
try {
  let js;
  if (linux) {
    sid = (await wd("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application: app } } } })).sessionId;
    js = (s) => wd("POST", `/session/${sid}/execute/sync`, { script: s, args: [] });
  } else js = await attach();
  await until(() => js(`return !!document.querySelector('[data-testid="btn-start"]')`), 30000, "UI");
  const radio = (g) => js(`const x = [...document.querySelectorAll('[role="radiogroup"]')].find((x) => x.getAttribute("aria-label") === ${JSON.stringify(g)}); return x && x.querySelector('[aria-checked="true"]') && x.querySelector('[aria-checked="true"]').textContent.trim();`);
  /** Chooses an option of the group other than the current one (labels differ between versions). */
  const pickOther = (g) => js(`const x = [...document.querySelectorAll('[role="radiogroup"]')].find((x) => x.getAttribute("aria-label") === ${JSON.stringify(g)});
    const o = [...x.querySelectorAll('[role="radio"]')].reverse().find((r) => r.getAttribute("aria-checked") !== "true"); o.click(); return o.textContent.trim();`);
  const dump = () => js(`return JSON.stringify(Object.fromEntries(Object.keys(localStorage).sort().map((k) => [k, localStorage.getItem(k)])))`);
  const ui = { mistakes: await radio("Typing mistakes"), fix: await radio("How typos get fixed"), theme: await js(`return document.documentElement.dataset.theme`) };
  if (mode === "before") {
    const chose = { mistakes: await pickOther("Typing mistakes") };
    await sleep(300);
    chose.fix = await pickOther("How typos get fixed");
    await sleep(300);
    const t = await js(`const b = [...document.querySelectorAll("button")].find((b) => /dark|light|theme/i.test(b.getAttribute("aria-label") || "")); if (b) b.click(); return b ? b.getAttribute("aria-label") : null;`);
    await sleep(600);
    const after = { mistakes: await radio("Typing mistakes"), fix: await radio("How typos get fixed"), theme: await js(`return document.documentElement.dataset.theme`) };
    if (after.mistakes !== chose.mistakes || after.fix !== chose.fix || after.mistakes === ui.mistakes) throw new Error(`the settings did not change: ${JSON.stringify(after)}`);
    const ls = JSON.parse(await dump());
    if (!Object.keys(ls).length) throw new Error("nothing was saved");
    writeFileSync(stateFile, JSON.stringify({ ui: after, ls }, null, 1));
    // SETTLE_MS: wait this long before closing (to tell a slow save from a lost one). Without it,
    // the app is closed at once.
    const settle = Number(process.env.SETTLE_MS || 0);
    if (settle) await sleep(settle);
    console.log(`before (${app}): theme button ${t}; ui ${JSON.stringify(after)}; ${Object.keys(ls).length} stored keys: ${Object.keys(ls).join(", ")}; closing ${settle ? `${settle} ms after the change` : "at once"}`);
  } else {
    const label = mode !== "after" ? "reopened, before the upgrade" : "after the upgrade";
    const saved = JSON.parse(readFileSync(stateFile, "utf8"));
    const ls = JSON.parse(await dump());
    const lost = Object.keys(saved.ls).filter((k) => !(k in ls));
    // A newer version may add fields of its own; every field the user had must keep its value.
    const parse = (v) => { try { return JSON.parse(v); } catch { return v; } };
    const kept = (was, now) => (was && typeof was === "object" && now && typeof now === "object" ? Object.keys(was).every((f) => JSON.stringify(was[f]) === JSON.stringify(now[f])) : was === now);
    const changed = Object.keys(saved.ls).filter((k) => k in ls && !kept(parse(saved.ls[k]), parse(ls[k])));
    console.log(`${label} (${app}): ui ${JSON.stringify(ui)}; keys kept ${Object.keys(saved.ls).length - lost.length}/${Object.keys(saved.ls).length}; lost [${lost}]; values changed [${changed}]`);
    for (const k of changed) console.log(`  changed ${k}:\n    was ${saved.ls[k].slice(0, 400)}\n    now ${ls[k].slice(0, 400)}`);
    if (mode === "control") {
      // What the old version really kept is what an upgrade can lose. Keys it lost by itself, and
      // the UI they set, are not the installer's: "after" then expects exactly what is shown now.
      const keptKeys = Object.keys(saved.ls).filter((k) => !lost.includes(k));
      const ok = keptKeys.length > 0 && changed.length === 0;
      writeFileSync(stateFile, JSON.stringify({ ui, ls: Object.fromEntries(keptKeys.map((k) => [k, saved.ls[k]])), lostByOldVersion: lost }, null, 1));
      console.log(`lost by the old version itself (not the installer): [${lost}]; the upgrade must keep the other ${keptKeys.length} keys and this UI`);
      console.log(`OLD VERSION KEPT SOME SETTINGS TO UPGRADE: ${ok ? "PASS" : "FAIL"}`);
      process.exitCode = ok ? 0 : 1;
    } else {
      const ok = lost.length === 0 && changed.length === 0 && JSON.stringify(ui) === JSON.stringify(saved.ui);
      const what = mode === "check" ? "SETTINGS SAVED BEFORE THE UPGRADE" : "UPGRADE PRESERVED SETTINGS";
      console.log(`${what}: ${ok ? "PASS" : "FAIL"}`);
      process.exitCode = ok ? 0 : 1;
    }
  }
  await closeLikeUser();
  console.log("closed like a user; the app exited by itself");
  if (!linux) {
    // Every launch saves its preferences, so a session in the real profile always writes it.
    const at = storageWritten();
    console.log(`the app's profile: page storage last written ${at ? new Date(at).toISOString() : "never"} (session started ${new Date(started).toISOString()})`);
    if (at < started - 2000) {
      console.log(`NOT THE APP'S PROFILE: the session's storage never reached ${PROFILE}, so this check proves nothing`);
      process.exitCode = 1;
    }
  }
} finally {
  if (sid) await wd("DELETE", `/session/${sid}`).catch(() => {});
  await cdp?.close().catch(() => {});
  await sleep(800);
  for (const p of procs.reverse()) p.kill("SIGTERM");
}
