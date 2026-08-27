import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/e2e/**/*.e2e.test.ts"],
    fileParallelism: false,
    hookTimeout: 240_000,
    testTimeout: 240_000,
  },
});
