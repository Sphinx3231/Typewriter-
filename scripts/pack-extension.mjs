// Zips dist-extension/ into release/typewriter-extension-<version>.zip (the file
// the Chrome Web Store accepts, with manifest.json at the root).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist-extension");
if (!existsSync(resolve(dist, "manifest.json"))) throw new Error("Build first: npm run extension:build");
const { version } = JSON.parse(readFileSync(resolve(dist, "manifest.json"), "utf8"));
const outDir = resolve(root, "release");
mkdirSync(outDir, { recursive: true });
const zip = resolve(outDir, `typewriter-extension-${version}.zip`);
rmSync(zip, { force: true });
execFileSync("zip", ["-r", "-X", "-q", zip, "."], { cwd: dist, stdio: "inherit" });
console.log(zip);
