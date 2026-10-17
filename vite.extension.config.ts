/**
 * Chrome extension build: the same app as the side panel page, plus the service
 * worker, the manifest and the icons, in dist-extension/.
 *
 * EXTENSION_TEST=1 builds a test-only variant in dist-extension-test/ where the
 * optional permission ("clipboardRead") is granted at install, because automated browsers can't
 * click Chrome's permission prompt. The shipped build asks for it at "Check copied text".
 * ("debugger" is a required permission in both: Chrome doesn't allow it to be optional.)
 */
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { buildDefines } from "./scripts/build-info.mjs";

const TEST = process.env.EXTENSION_TEST === "1";
const outDir = TEST ? "dist-extension-test" : "dist-extension";

function extensionFiles(): Plugin {
  return {
    name: "typewriter-extension-files",
    apply: "build",
    writeBundle() {
      const out = resolve(__dirname, outDir);
      const manifest = JSON.parse(readFileSync(resolve(__dirname, "extension/manifest.json"), "utf8"));
      const pkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8"));
      manifest.version = pkg.version;
      if (TEST) {
        manifest.name = "Typewriter (test build)";
        manifest.permissions = [...manifest.permissions, ...manifest.optional_permissions];
        manifest.optional_permissions = [];
      }
      writeFileSync(resolve(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
      mkdirSync(resolve(out, "icons"), { recursive: true });
      for (const f of readdirSync(resolve(__dirname, "extension/icons"))) copyFileSync(resolve(__dirname, "extension/icons", f), resolve(out, "icons", f));
    },
  };
}

export default defineConfig({
  plugins: [react(), extensionFiles()],
  base: "./",
  define: buildDefines(),
  build: {
    outDir,
    emptyOutDir: true,
    // Extension pages may only run scripts from the package itself.
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: { index: "index.html", background: "src/extension/background.ts" },
      output: {
        entryFileNames: (chunk) => (chunk.name === "background" ? "background.js" : "assets/[name]-[hash].js"),
      },
    },
  },
});
