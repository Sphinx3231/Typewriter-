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
  },
} as Parameters<typeof defineConfig>[0]);
