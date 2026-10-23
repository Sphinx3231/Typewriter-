/**
 * Upgrade check: the settings a user saved in the installed version survive installing the new
 * version over it.
 *
 *   node e2e-desktop/upgrade.mjs before <app> <state.json>   in the old version: change settings, save them
 *   (install the new version over the old one)
 *   node e2e-desktop/upgrade.mjs after <app> <state.json>    in the new version: every saved setting is still there
 *
 * Linux: runs on its own Xvfb display (:98) and uses $HOME as the user. Windows: the current user.
 * Needs tauri-driver (and msedgedriver on Windows) on PATH.
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const [mode, app, stateFile] = process.argv.slice(2);
const linux = process.platform === "linux";
const env = linux ? { ...process.env, DISPLAY: ":98", GDK_BACKEND: "x11", XDG_SESSION_TYPE: "x11" } : process.env;
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
async function until(fn, ms, what) { const t = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch {} if (Date.now() - t > ms) throw new Error("timed out: " + what); await sleep(200); } }
if (linux) {
  bg("Xvfb", [":98", "-screen", "0", "1600x1000x24", "-nolisten", "tcp"]);
  await sleep(800);
  bg("openbox", ["--sm-disable"]);
}
bg("tauri-driver", ["--port", "4455", "--native-port", "4456"]); // away from the harness defaults (4444, 4445)
await until(() => fetch(WD + "/status").then((r) => r.ok), 15000, "tauri-driver");
let sid;
try {
  sid = (await wd("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application: app } } } })).sessionId;
  const js = (s) => wd("POST", `/session/${sid}/execute/sync`, { script: s, args: [] });
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
    console.log(`before (${app}): theme button ${t}; ui ${JSON.stringify(after)}; ${Object.keys(ls).length} stored keys: ${Object.keys(ls).join(", ")}`);
  } else {
    const saved = JSON.parse(readFileSync(stateFile, "utf8"));
    const ls = JSON.parse(await dump());
    const lost = Object.keys(saved.ls).filter((k) => !(k in ls));
    // A newer version may add fields of its own; every field the user had must keep its value.
    const parse = (v) => { try { return JSON.parse(v); } catch { return v; } };
    const kept = (was, now) => (was && typeof was === "object" && now && typeof now === "object" ? Object.keys(was).every((f) => JSON.stringify(was[f]) === JSON.stringify(now[f])) : was === now);
    const changed = Object.keys(saved.ls).filter((k) => k in ls && !kept(parse(saved.ls[k]), parse(ls[k])));
    console.log(`after (${app}): ui ${JSON.stringify(ui)}; keys kept ${Object.keys(saved.ls).length - lost.length}/${Object.keys(saved.ls).length}; lost [${lost}]; values changed [${changed}]`);
    for (const k of changed) console.log(`  changed ${k}:\n    was ${saved.ls[k].slice(0, 400)}\n    now ${ls[k].slice(0, 400)}`);
    const ok = lost.length === 0 && changed.length === 0 && JSON.stringify(ui) === JSON.stringify(saved.ui);
    console.log(ok ? "UPGRADE PRESERVED SETTINGS: PASS" : "UPGRADE PRESERVED SETTINGS: FAIL");
    process.exitCode = ok ? 0 : 1;
  }
} finally {
  if (sid) await wd("DELETE", `/session/${sid}`).catch(() => {});
  await sleep(800);
  for (const p of procs.reverse()) p.kill("SIGTERM");
}
