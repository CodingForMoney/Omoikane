import { afterEach, describe, expect, it } from "vitest";
import type { Container } from "../src/container.js";
import { ValidationError } from "../src/database.js";
import { OMOIKANE_VERSION } from "../src/runtime-versions.js";
import packageJson from "../package.json" with { type: "json" };
import { testContainer } from "./helpers.js";

let container: Container | undefined;
let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  container = undefined;
  cleanup = undefined;
});

describe("provider registry", () => {
  it("keeps the runtime and npm package versions aligned", () => {
    expect(OMOIKANE_VERSION).toBe(packageJson.version);
  });

  it("ships known context and reasoning capabilities", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const catalog = container.providers.catalog();
    expect(catalog.length).toBeGreaterThanOrEqual(25);
    const bridge = catalog.find((item) => item.id === "codex_bridge")!;
    expect(bridge.models[0]!.capabilities.context_window).toBe(258_400);
    const mimo = catalog.find((item) => item.id === "xiaomi_mimo")!;
    expect(
      mimo.models.find((item) => item.id === "mimo-v2.5")!.capabilities,
    ).toMatchObject({ context_window: 1_048_576 });
  });

  it("maps supported effort and rejects it for unsupported models", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const mimo = await container.providers.create("test", {
      name: "MiMo",
      provider: "xiaomi_mimo",
      api_key: "test-only-key",
    });
    const resolved = await container.providers.resolveConfig("test", {
      provider: { connection_id: mimo.id },
      model: "mimo-v2.5",
      model_settings: { reasoning_effort: "high", max_tokens: 4096 },
    });
    expect(resolved.model_settings).toMatchObject({
      reasoning: { effort: "high" },
      maxTokens: 4096,
    });
    expect(resolved.model_context_window).toBe(1_048_576);

    const qwen = await container.providers.create("test", {
      name: "Qwen",
      provider: "alibaba_qwen",
      api_key: "test-only-key",
    });
    await expect(
      container.providers.resolveConfig("test", {
        provider: { connection_id: qwen.id },
        model: "qwen3.7-plus",
        model_settings: { reasoning_effort: "high" },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
