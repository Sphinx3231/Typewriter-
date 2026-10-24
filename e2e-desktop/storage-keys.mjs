/**
 * Diagnostics: which of Typewriter's page-storage keys are on disk in the webview profile, and in
 * which files. Run it while the app is closed. Then a key the app lost was either never written
 * (missing here) or written but not read back (found here).
 *
 *   node e2e-desktop/storage-keys.mjs <profile dir> [key ...]
 *
 * Only prints key names, file names, sizes and times: never the stored values.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const [root, ...wanted] = process.argv.slice(2);
const keys = wanted.length ? wanted : ["typewriter:settings", "typewriter:theme", "typewriter:prefs", "typewriter:history"];
const files = [];
const walk = (dir) => {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    console.log(`cannot read ${dir}: ${e.code ?? e.message}`);
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/local ?storage/i.test(p)) files.push(p); // WebView2: "Local Storage"; WebKitGTK: "localstorage"
  }
};
walk(root);
console.log(`Local Storage files under ${root}: ${files.length}`);
const found = new Map(keys.map((k) => [k, []]));
for (const f of files) {
  const st = statSync(f);
  let hits = [];
  try {
    const buf = readFileSync(f);
    // Chromium stores a key as Latin-1 or UTF-16LE bytes.
    const latin1 = buf.toString("latin1");
    const utf16 = buf.toString("utf16le") + buf.subarray(1).toString("utf16le");
    hits = keys.filter((k) => latin1.includes(k) || utf16.includes(k));
  } catch (e) {
    hits = [`(unreadable: ${e.code ?? e.message})`];
  }
  for (const k of hits) found.get(k)?.push(f);
  console.log(`  ${f.slice(root.length + 1)}  ${st.size} bytes  modified ${st.mtime.toISOString()}  ${hits.length ? hits.join(", ") : "-"}`);
}
for (const [k, where] of found) console.log(`${k}: ${where.length ? `on disk (${where.length} file${where.length > 1 ? "s" : ""})` : "NOT on disk"}`);
