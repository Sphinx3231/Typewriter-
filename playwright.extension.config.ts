import { defineConfig } from "@playwright/test";

// Chrome extension tests: each test launches Chromium with the unpacked extension loaded.
export default defineConfig({
  testDir: "e2e-extension",
  timeout: 90_000,
  workers: 1,
  reporter: [["list"]],
  webServer: {
    command: "node e2e-extension/serve.mjs",
    url: "http://127.0.0.1:4174/target.html",
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
