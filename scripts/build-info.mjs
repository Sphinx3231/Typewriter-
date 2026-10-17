// The version and commit a build was made from, shown in Settings › About so a
// running copy can be matched to a source revision.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const git = (...args) => execFileSync("git", args, { cwd: resolve(import.meta.dirname, ".."), stdio: ["ignore", "pipe", "ignore"] }).toString().trim();

export function buildInfo() {
  const { version } = JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"));
  let commit = process.env.GITHUB_SHA?.slice(0, 7) ?? "unknown";
  try {
    commit = git("rev-parse", "--short=7", "HEAD");
    // Source files changed since that commit (generated output doesn't count).
    if (git("status", "--porcelain", "--untracked-files=no", "--", "src", "src-tauri/src", "src-tauri/native/src", "extension")) commit += "+local";
  } catch {
    /* not a git checkout */
  }
  return { version, commit };
}

/** Vite `define` entries for the build info. */
export function buildDefines() {
  const { version, commit } = buildInfo();
  return { __APP_VERSION__: JSON.stringify(version), __APP_COMMIT__: JSON.stringify(commit) };
}
