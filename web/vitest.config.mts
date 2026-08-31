import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    globalSetup: ["./vitest.global-setup.ts"],
    // Playwright specs live in e2e/ and are run by `npm run e2e`, not Vitest.
    include: ["src/**/*.test.{ts,tsx}"],
    // Repository tests share one SQLite file; run them in a single worker so
    // they cannot interleave truncations with each other's writes.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
