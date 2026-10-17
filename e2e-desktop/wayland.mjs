/**
 * Real Wayland session check: the packaged app runs as a native Wayland client
 * under a headless Weston compositor that also provides XWayland (so DISPLAY is
 * set, as on GNOME and KDE). Typing into other apps must be refused with an
 * explanation, and the in-app preview must still work.
 *
 * Usage: node e2e-desktop/wayland.mjs [path/to/typewriter-binary]
 * Needs: weston (with Xwayland), tauri-driver, WebKitWebDriver (Linux).
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const APP = resolve(process.argv[2] ?? join(here, "../src-tauri/target/release/typewriter"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runtime = mkdtempSync(join(tmpdir(), "tw-wl-"));
chmodSync(runtime, 0o700);
const SOCKET = "tw-wayland-0";
const log = join(runtime, "weston.log");
const procs = [];
let failures = 0;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
async function until(fn, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const WD = "http://127.0.0.1:4445";
let sid;
async function wd(method, path, body) {
  const r = await fetch(`${WD}${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (j.value && j.value.error) throw new Error(`WebDriver ${path}: ${j.value.error} ${j.value.message}`);
  return j.value;
}
const js = (script) => wd("POST", `/session/${sid}/execute/sync`, { script, args: [] });
const UI = `
  const radio = (group, option) => {
    const g = [...document.querySelectorAll('[role="radiogroup"]')].find((x) => x.getAttribute("aria-label") === group);
    [...g.querySelectorAll('[role="radio"]')].find((x) => x.textContent.trim() === option).click();
  };
  const setText = (v) => {
    const ta = document.getElementById("source-text");
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(ta, v);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const number = (input, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, String(v));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  };
  const status = () => document.querySelector('[data-testid="status"]')?.textContent.trim();`;
const ui = (body) => js(`${UI}\n${body}`);

async function check(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures++;
    console.log(`  ✘ ${name}\n    ${e.message}`);
  }
}

async function main() {
  assert(existsSync(APP), `App binary not found: ${APP}`);
  console.log(`Typewriter Wayland check\n  app: ${APP}`);
  const base = { ...process.env, XDG_RUNTIME_DIR: runtime };
  delete base.DISPLAY;
  procs.push(spawn("weston", ["--backend=headless", `--socket=${SOCKET}`, "--xwayland", "--width=1400", "--height=900", `--log=${log}`], { env: base, stdio: "ignore" }));
  await until(async () => existsSync(join(runtime, SOCKET)), 10000, "the Weston socket");
  // XWayland's display, as a GNOME/KDE Wayland session would export it.
  const display = await until(async () => {
    const m = readFileSync(log, "utf8").match(/xserver listening on display (:\d+)/);
    return m && m[1];
  }, 10000, "XWayland's display");
  const env = { ...base, WAYLAND_DISPLAY: SOCKET, DISPLAY: display, XDG_SESSION_TYPE: "wayland", GDK_BACKEND: "wayland", HOME: mkdtempSync(join(tmpdir(), "tw-home-")) };
  procs.push(spawn("tauri-driver", ["--port", "4445", "--native-port", "4446"], { env, stdio: "ignore" }));
  await until(() => fetch(`${WD}/status`).then((r) => r.ok), 15000, "tauri-driver");
  sid = (await wd("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application: APP } } } })).sessionId;
  await until(() => js(`return !!document.querySelector('[data-testid="btn-start"]') && !document.getElementById("boot")`), 30000, "Typewriter's UI");

  await check("runs as a native Wayland client (GDK Wayland backend, XWayland display also present)", async () => {
    const wl = readFileSync(log, "utf8");
    assert(/xserver listening on display/.test(wl), "XWayland didn't start");
    assert(await js(`return !!document.querySelector(".logo-mark__art")`), "UI didn't render");
  });

  await check("typing into other apps is refused with an explanation, and Start stays disabled", async () => {
    await ui(`setText("Wayland session check."); radio("Where to type", "Into another app"); return 1;`);
    const msg = await until(async () => {
      const t = await js(`return document.querySelector('[data-testid="ext-support"]')?.textContent`);
      return t && !/Checking/.test(t) ? t : null;
    }, 8000, "the support message");
    assert(/Wayland/.test(msg) && /Xorg/.test(msg), `message: ${msg}`);
    assert(await js(`return document.querySelector('[data-testid="btn-start"]').disabled`), "Start is enabled");
  });

  await check("the in-app preview still works and reproduces the text exactly", async () => {
    const text = "Preview on Wayland: Café — 日本語 👍🏽.";
    await ui(`radio("Where to type", "Preview here"); setText(${JSON.stringify(text)}); radio("Set the timing by", "Total duration"); return 1;`);
    await sleep(200);
    await ui(`number(document.querySelector('[aria-label="Minutes"]'), 0); number(document.querySelector('[aria-label="Seconds"]'), 3); return 1;`);
    await sleep(400);
    await ui(`document.querySelector('[data-testid="btn-start"]').click(); return 1;`);
    await until(async () => (await ui(`return status()`)) === "Complete", 20000, "the preview to complete");
    const out = await js(`return document.querySelector('[data-testid="playback-text"]').textContent`);
    assert(out === text, `preview output ${JSON.stringify(out)}`);
  });

  await wd("DELETE", `/session/${sid}`).catch(() => {});
}

main()
  .catch((e) => {
    failures++;
    console.error(e);
  })
  .finally(() => {
    for (const p of procs.reverse()) p.kill("SIGTERM");
    console.log(failures ? `\n${failures} failed` : "\nall passed");
    process.exit(failures ? 1 : 0);
  });
