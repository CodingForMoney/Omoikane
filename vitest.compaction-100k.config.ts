import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/e2e/mimo-compaction-100k.e2e.test.ts"],
    fileParallelism: false,
    hookTimeout: 600_000,
    testTimeout: 600_000,
  },
});
