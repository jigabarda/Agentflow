import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    globalSetup: ["./vitest.global-setup.ts"],
    include: ["src/**/*.test.ts"],
    // Integration tests share one SQLite file; keep them off each other's toes.
    fileParallelism: false,
  },
});
