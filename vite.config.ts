import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { buildDefines } from "./scripts/build-info.mjs";

export default defineConfig({
  plugins: [react()],
  base: "./",
  define: buildDefines(),
  build: {
    rollupOptions: {
      input: { main: "index.html", hud: "hud.html" },
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    coverage: {
      provider: "v8",
      // Every source file of the app, the status window and the extension counts,
      // including the ones no test imports yet.
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/**/*.d.ts"],
      reporter: ["text", "json-summary", "html"],
      thresholds: { lines: 95, statements: 95, functions: 95, branches: 95 },
    },
  },
} as Parameters<typeof defineConfig>[0]);
