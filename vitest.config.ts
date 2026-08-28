import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // PGlite and local MCP integration files contend heavily when Vitest runs
    // them in parallel, causing wall-clock timeouts rather than test failures.
    maxWorkers: 1,
    exclude: [...configDefaults.exclude, "test/e2e/**", "test/postgres/**"],
  },
});
