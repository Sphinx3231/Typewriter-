import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Windows and macOS file systems ignore case: `import "./license"` next to a `LICENSE` file
// loaded the text file there and broke the Windows and macOS builds (run 39), while every
// Linux build passed. No two paths under src/ may differ only by case.
describe("source paths", () => {
  it("no two files or folders under src/ differ only by letter case", () => {
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        const key = relative("src", p).toLowerCase();
        const stem = key.replace(/\.[^./]+$/, ""); // "license.ts" also clashes with "LICENSE" in an extensionless import
        for (const k of new Set([key, stem])) {
          const other = seen.get(k);
          if (other && other !== p) clashes.push(`${other} ↔ ${p}`);
          else seen.set(k, p);
        }
        if (e.isDirectory()) walk(p);
      }
    };
    walk("src");
    expect(clashes).toEqual([]);
  });
});
