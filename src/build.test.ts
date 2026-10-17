import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { APP_COMMIT, APP_VERSION } from "./build";

describe("build info", () => {
  it("shows the package version and the commit the build was made from", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(APP_VERSION).toBe(pkg.version);
    expect(APP_COMMIT).toMatch(/^[0-9a-f]{7}(\+local)?$/);
  });
});
