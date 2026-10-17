/**
 * Windows end-to-end test: the real Typewriter.exe types into a real native Windows
 * text window with real key events (SendInput), on a real Windows desktop.
 *
 *   tauri-driver + msedgedriver   operate Typewriter's own UI (main window and status window)
 *   e2e-desktop/win/target.ps1    the destination: a native Win32 text box that saves its text
 *   e2e-desktop/win/input.ps1     the user's real mouse clicks and shortcut presses, and screenshots
 *
 * It then types into real Chromium browsers (Chrome, Edge, and Opera when installed) on a
 * page that takes input the way Google Docs does (e2e-extension/fixtures/strict-editor.html),
 * reading the result over the DevTools protocol.
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
  targets[key] = { out, title, x: rx, y: ry, w: rw, h: rh, proc: p };
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


// ---------------------------------------------------------------- real browsers
const STRICT = resolve(here, "../e2e-extension/fixtures/strict-editor.html");
const BROWSERS = [
  ["Chrome", ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"]],
  ["Edge", ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"]],
  [
    "Opera",
    [join(process.env.LOCALAPPDATA ?? "", "Programs\\Opera\\opera.exe"), "C:\\Program Files\\Opera\\opera.exe", "C:\\Program Files (x86)\\Opera\\opera.exe"],
  ],
];
/** Evaluates an expression in the browser page whose URL contains `urlPart`. */
async function cdpEval(port, urlPart, expression) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
  const t = list.find((x) => (x.type === "page" || x.type === "service_worker") && x.url.includes(urlPart));
  if (!t) throw new Error(`no page with ${urlPart} (pages: ${list.map((x) => x.url).join(", ")})`);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((ok, fail) => ((ws.onopen = ok), (ws.onerror = () => fail(new Error("DevTools connection failed")))));
  try {
    const res = await new Promise((ok, fail) => {
      const timer = setTimeout(() => fail(new Error("DevTools didn't answer")), 5000);
      ws.onmessage = (m) => {
        const d = JSON.parse(m.data);
        if (d.id === 1) (clearTimeout(timer), ok(d));
      };
      ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
    });
    const ex = res.result?.exceptionDetails;
    if (ex) throw new Error(ex.exception?.description ?? ex.text);
    if (res.error) throw new Error(res.error.message);
    return res.result?.result?.value;
  } finally {
    ws.close();
  }
}
async function browserCheck(name, exe, port) {
  const profile = mkdtempSync(join(tmpdir(), `tw-${name}-`));
  const p = spawn(
    exe,
    [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      "--remote-allow-origins=*",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=Translate",
      "--window-position=60,40",
      "--window-size=960,640",
      "--new-window",
      `file:///${STRICT.replace(/\\/g, "/")}`,
    ],
    { stdio: "ignore" },
  );
  procs.push(p);
  try {
    await until(() => cdpEval(port, "strict-editor", "typeof modelText === 'function'"), 30000, `${name} to load the page`);
    await configure(TRICKY, { seconds: 20, mistakes: "Medium" });
    await start();
    // A real click on the page's canvas, like clicking into a Google Docs page.
    const [cx, cy] = await cdpEval(
      port,
      "strict-editor",
      `(() => { const r = document.getElementById("page").getBoundingClientRect(), k = devicePixelRatio;
        const bx = (outerWidth - innerWidth) / 2, by = outerHeight - innerHeight - bx;
        return [Math.round((screenX + bx + r.left + 120) * k), Math.round((screenY + by + r.top + 60) * k)]; })()`,
    );
    const hidden = ps("input.ps1", "hideconsoles");
    if (hidden) console.log(`    ${hidden.split("\n").join("\n    ")}`);
    ps("input.ps1", "click", cx, cy);
    await until(async () => /Strict editor/.test(ps("input.ps1", "fg")), 3000, `${name} to have focus after the click`).catch((e) => {
      throw new Error(`${e.message}; the click chose "${ps("input.ps1", "fg")}" instead`);
    });
    const t0 = Date.now();
    await until(async () => (await cdpEval(port, "strict-editor", "modelText()")).length > 0, 20000, `the first character to arrive in ${name}`);
    console.log(`    first character arrived ${((Date.now() - t0) / 1000).toFixed(1)} s after the click (countdown 3 s)`);
    shot(`win-browser-${name.toLowerCase()}-typing`);
    await until(async () => (await hudPhase()) === "completed", 90000, "the session to complete");
    await sleep(500);
    shot(`win-browser-${name.toLowerCase()}-completed`);
    const got = await cdpEval(port, "strict-editor", "modelText()");
    const rejected = await cdpEval(port, "strict-editor", "model.rejected");
    assert(rejected === 0, `${name} received ${rejected} untrusted (script-made) events`);
    assert(got === TRICKY, `final text in ${name} differs.\n    want ${JSON.stringify(TRICKY)}\n    got  ${JSON.stringify(got)}`);
  } finally {
    p.kill();
    try {
      execFileSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
  }
}

async function operaExtensionCheck(exe, ext, port) {
  const profile = mkdtempSync(join(tmpdir(), "tw-opera-ext-"));
  const p = spawn(
    exe,
    [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      "--remote-allow-origins=*",
      "--no-first-run",
      "--no-default-browser-check",
      `--load-extension=${ext}`,
      "--disable-features=DisableLoadExtensionCommandLineSwitch",
      "--window-position=60,40",
      "--window-size=960,640",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  procs.push(p);
  try {
    const sw = await until(async () => {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
      return list.find((x) => x.type === "service_worker" && x.url.startsWith("chrome-extension://") && x.url.endsWith("/background.js"));
    }, 30000, "Typewriter's service worker in Opera (the unpacked extension didn't load)");
    const id = new URL(sw.url).host;
    const apis = await cdpEval(
      port,
      sw.url,
      `(() => { const c = globalThis.chrome || {}, o = globalThis.opr || {};
        return JSON.stringify({ sidePanel: typeof c.sidePanel, debugger: typeof c.debugger, sidebarAction: typeof o.sidebarAction, ua: navigator.userAgent }); })()`,
    );
    console.log(`    Opera extension APIs: ${apis}`);
    // Open the panel page in a tab, the way a side panel would load it.
    await fetch(`http://127.0.0.1:${port}/json/new?chrome-extension://${id}/index.html`, { method: "PUT", signal: AbortSignal.timeout(5000) });
    const ui = await until(
      () => cdpEval(port, `chrome-extension://${id}/index.html`, `document.querySelector('[data-testid="btn-start"]') ? document.body.innerText.slice(0, 80) : null`),
      15000,
      "the panel page to render in Opera",
    );
    console.log(`    panel page renders: ${JSON.stringify(ui)}`);
    shot("win-opera-extension-page");
    const a = JSON.parse(apis);
    assert(a.sidePanel === "object", `chrome.sidePanel is ${a.sidePanel} in Opera, so the side panel can't open (Opera's own sidebar API: ${a.sidebarAction})`);
    assert(a.debugger === "object", `chrome.debugger is ${a.debugger} in Opera, so the extension can't type`);
  } finally {
    p.kill();
    try {
      execFileSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
  }
}

// ---------------------------------------------------------------- the same short text into three targets
const SHORT = "Hello from Typewriter 123.";
const PLAIN = resolve(here, "win/textarea.html");
const results = [];
/** The app's diagnostic trail for the latest session (timings and window types, never text). */
async function lastDiagnostics() {
  const v = await wd("POST", `/session/${sid}/execute/async`, {
    script: `const done = arguments[arguments.length - 1];
      window.__TAURI_INTERNALS__.invoke("diagnostics").then((r) => done(r[1]), (e) => done("unavailable: " + e));`,
    args: [],
  });
  const at = v.lastIndexOf("\n=== ");
  return at >= 0 ? v.slice(at + 1) : v;
}
async function launchBrowser(name, exe, port, page) {
  const profile = mkdtempSync(join(tmpdir(), `tw-${name}-`));
  const p = spawn(
    exe,
    [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, "--remote-allow-origins=*", "--no-first-run", "--no-default-browser-check", "--disable-features=Translate", "--window-position=60,40", "--window-size=960,640", "--new-window", `file:///${page.replace(/\\/g, "/")}`],
    { stdio: "ignore" },
  );
  procs.push(p);
  return p;
}
const killTree = (p) => {
  p.kill();
  try {
    execFileSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    /* already gone */
  }
};
/** Screen point (physical pixels) inside an element of a browser page. */
const pagePoint = (port, part, selector, dx, dy) =>
  cdpEval(
    port,
    part,
    `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(), k = devicePixelRatio;
      const bx = (outerWidth - innerWidth) / 2, by = outerHeight - innerHeight - bx;
      return [Math.round((screenX + bx + r.left + ${dx}) * k), Math.round((screenY + by + r.top + ${dy}) * k)]; })()`,
  );
function threeTargets(opera) {
  const targets = [
    {
      name: "Windows Notepad",
      async open() {
        this.p = spawn("notepad.exe", [], { stdio: "ignore" });
        procs.push(this.p);
        await until(async () => ps("input.ps1", "findclass", "Notepad") || null, 15000, "Notepad's window");
      },
      async point() {
        const [x, y, w, h] = ps("input.ps1", "findclass", "Notepad").split(" ").map(Number);
        return [Math.round(x + w / 2), Math.round(y + h / 2)];
      },
      focus: /Notepad/,
      async read() {
        return Buffer.from(ps("input.ps1", "notepadtext"), "base64").toString("utf8").replace(/\r\n/g, "\n");
      },
      close() {
        killTree(this.p);
        try {
          execFileSync("taskkill", ["/IM", "notepad.exe", "/F"], { stdio: "ignore" });
        } catch {
          /* already gone */
        }
      },
    },
  ];
  if (opera) {
    targets.push(
      {
        name: "a plain text field in Opera",
        port: 9601,
        async open() {
          this.p = await launchBrowser("opera-plain", opera, this.port, PLAIN);
          await until(() => cdpEval(this.port, "textarea.html", "!!document.getElementById('t')"), 30000, "Opera to load the page");
        },
        point() {
          return pagePoint(this.port, "textarea.html", "#t", 100, 40);
        },
        focus: /Plain text field/,
        read() {
          return cdpEval(this.port, "textarea.html", "document.getElementById('t').value");
        },
        close() {
          killTree(this.p);
        },
      },
      {
        name: "a Google-Docs-like page in Opera (a stand-in, not Google Docs)",
        port: 9602,
        async open() {
          this.p = await launchBrowser("opera-docs", opera, this.port, STRICT);
          await until(() => cdpEval(this.port, "strict-editor", "typeof modelText === 'function'"), 30000, "Opera to load the page");
        },
        point() {
          return pagePoint(this.port, "strict-editor", "#page", 120, 60);
        },
        focus: /Strict editor/,
        read() {
          return cdpEval(this.port, "strict-editor", "modelText()");
        },
        close() {
          killTree(this.p);
        },
      },
    );
  }
  return targets;
}
async function typeIntoTarget(t) {
  const row = { target: t.name, started: false, firstCharAfterClickS: null, final: null, exact: false };
  results.push(row);
  await t.open();
  try {
    await configure(SHORT, { seconds: 6, mistakes: "Off", countdown: 3 });
    await start();
    row.started = true;
    const [x, y] = await t.point();
    const hidden = ps("input.ps1", "hideconsoles");
    if (hidden) console.log(`    ${hidden.split("\n").join("\n    ")}`);
    ps("input.ps1", "click", x, y);
    await until(async () => t.focus.test(ps("input.ps1", "fg")), 3000, `${t.name} to have focus after the click`).catch((e) => {
      throw new Error(`${e.message}; the click chose "${ps("input.ps1", "fg")}" instead`);
    });
    const t0 = Date.now();
    const first = await until(async () => ((await t.read()) || "").length > 0, 20000, `the first character to arrive in ${t.name}`).catch((e) => e);
    if (!(first instanceof Error)) row.firstCharAfterClickS = +((Date.now() - t0) / 1000).toFixed(1);
    await until(async () => ["completed", "stopped", "failed"].includes(await hudPhase()), 60000, "the session to end").catch(() => {});
    await sleep(500);
    shot(`win-three-${results.length}`);
    row.final = await t.read();
    row.exact = row.final === SHORT;
    row.phase = await hudPhase();
    console.log(`    ${t.name}: first character ${row.firstCharAfterClickS === null ? "NEVER arrived" : `arrived ${row.firstCharAfterClickS} s after the click`}; session ${row.phase}; text ${row.exact ? "exact" : `differs: ${JSON.stringify(row.final)}`}`);
    console.log(`    diagnostics:\n      ${(await lastDiagnostics()).trim().split("\n").join("\n      ")}`);
    if (first instanceof Error) throw first;
    assert(row.exact, `final text in ${t.name} differs: ${JSON.stringify(row.final)}`);
  } finally {
    await ui(`(__tw.has("btn-cancel") ? __tw.click("btn-cancel") : __tw.has("btn-stop") && __tw.click("btn-stop"), 1)`).catch(() => {});
    t.close();
  }
}

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

  await check("the app under test is the intended build (Settings shows its version and commit)", async () => {
    await ui(`(document.querySelector('[data-testid="nav-settings"]').click(), 1)`);
    const about = await until(() => js(`const b = document.querySelector('[data-testid="build-id"]'); return b && [document.getElementById("prefs-about").textContent.trim(), b.textContent.trim()]`), 8000, "Settings › About");
    console.log(`    ${about[0]}, ${about[1]} (app: ${APP})`);
    shot("win-00-about");
    const want = (process.env.EXPECT_COMMIT ?? "").slice(0, 7);
    if (want) assert(about[1] === `Build ${want}`, `the app shows "${about[1]}", expected "Build ${want}": this isn't the build under test`);
    await ui(`(document.querySelector('[data-testid="nav-workspace"]').click(), 1)`);
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
    // The target saves its text every 150 ms, and a key sent just before the pause may still be in
    // Windows' input queue: let both settle, then nothing more may arrive while paused.
    await sleep(500);
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

  // The native text windows stay on top; close them so the other windows can be clicked.
  for (const t of Object.values(targets)) t.proc.kill();
  const operaExe = BROWSERS.find(([n]) => n === "Opera")[1].find((x) => existsSync(x));
  if (!operaExe) console.log("  - Opera isn't installed: only Notepad in the three-target test");
  for (const t of threeTargets(operaExe)) {
    await check(`the same short text into ${t.name}: the first character arrives and the text is exact`, () => typeIntoTarget(t));
  }
  console.log("\n  Three-target summary:");
  for (const r of results) console.log(`    ${r.target}: first character ${r.firstCharAfterClickS === null ? "never" : `${r.firstCharAfterClickS} s after the click`}, ${r.exact ? "exact" : "NOT exact"}`);
  console.log("");
  let port = 9555;
  for (const [name, paths] of BROWSERS) {
    const exe = paths.find((x) => existsSync(x));
    if (!exe) {
      console.log(`  - types into ${name}: skipped, ${name} isn't installed`);
      continue;
    }
    await check(`types into a Google-Docs-like page in ${name}, exactly`, () => browserCheck(name, exe, port++));
  }

  // The Chrome extension in Opera: Opera supports only part of Chrome's extension APIs.
  const opera = BROWSERS.find(([n]) => n === "Opera")[1].find((x) => existsSync(x));
  const ext = resolve(here, "../dist-extension");
  if (opera && existsSync(join(ext, "manifest.json"))) {
    await check("the Chrome extension in Opera: the APIs it needs exist and its panel page renders", () => operaExtensionCheck(opera, ext, port++));
  } else {
    console.log(`  - the Chrome extension in Opera: skipped (${opera ? "dist-extension not built" : "Opera isn't installed"})`);
  }

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
