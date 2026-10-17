import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Permissions Chrome refuses to treat as optional. Listing one under optional_permissions
 * makes Chrome drop it, and permissions.request() then fails with "Only permissions
 * specified in the manifest may be requested". Source: developer.chrome.com, chrome.permissions.
 */
const NEVER_OPTIONAL = ["debugger", "declarativeNetRequest", "devtools", "experimental", "geolocation", "mdns", "proxy", "tts", "ttsEngine", "wallpaper"];

const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../extension/manifest.json"), "utf8")) as {
  permissions?: string[];
  optional_permissions?: string[];
};

describe("extension manifest", () => {
  it("never lists a permission Chrome can't grant as optional", () => {
    expect((manifest.optional_permissions ?? []).filter((p) => NEVER_OPTIONAL.includes(p))).toEqual([]);
  });
  it("requires debugger, which typing into pages depends on", () => {
    expect(manifest.permissions).toContain("debugger");
  });
});
