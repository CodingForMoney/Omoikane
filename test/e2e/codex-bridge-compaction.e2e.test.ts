import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Container } from "../../src/container.js";
import { getSettings } from "../../src/config.js";
import { Container as RuntimeContainer } from "../../src/container.js";

const marker = "BRIDGE-NATIVE-7429";
let root = "";
let container: Container | undefined;

describe.sequential("Codex Bridge native compaction E2E", () => {
  beforeAll(async () => {
    if (!process.env.CODEX_BRIDGE_API_KEY) {
      try {
        const stored = JSON.parse(
          await readFile(join(homedir(), ".cb", "config.json"), "utf8"),
        ) as { apiKey?: string };
        if (stored.apiKey) process.env.CODEX_BRIDGE_API_KEY = stored.apiKey;
      } catch {
        // The explicit environment variable remains the portable CI path.
      }
    }
    if (!process.env.CODEX_BRIDGE_API_KEY)
      throw new Error(
        "CODEX_BRIDGE_API_KEY is required in the process environment",
      );
    root = await mkdtemp(join(tmpdir(), "omoikane-codex-bridge-compact-"));
    container = await RuntimeContainer.create(
      getSettings({
        AGENT_DATABASE_URL: "pglite://:memory:",
        AGENT_ARTIFACT_ROOT: join(root, "artifacts"),
        AGENT_SKILL_ROOT: join(root, "skills"),
        AGENT_SANDBOX_ROOT: join(root, "sandboxes"),
        AGENT_CREDENTIAL_SECRET: "codex-bridge-e2e-ephemeral-secret",
        AGENT_TRACING_DISABLED: "true",
        AGENT_AUTO_MIGRATE: "true",
      }),
      { startWorker: false },
    );
  });

  afterAll(async () => {
    await container?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("compacts through /responses/compact and continues through /responses", async () => {
    const runtime = container!;
    const connection = await runtime.providers.create({
      name: "Local Codex Bridge E2E",
      provider: "codex_bridge",
      api_key: process.env.CODEX_BRIDGE_API_KEY,
    });
    const deployment = await runtime.definitions.deploy({
      config: {
        name: "Codex Bridge native compaction verifier",
        instructions:
          "Preserve exact verification codes. When asked for one, return only that code.",
        provider: { connection_id: connection.id },
        model: "gpt-5.6-sol",
        model_context_window: 258_400,
        model_settings: { reasoning_effort: "none", max_tokens: 128 },
        tools: [],
        skills: [],
        mcp_servers: [],
        compaction: { enabled: true, strategy: "native" },
      },
    });
    const filler =
      "This assistant-only material exists to exercise native context compaction. ".repeat(
        1_500,
      );
    const conversation = [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Remember the exact verification code ${marker}.`,
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "output_text", text: filler }],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Keep the verification code available for the next turn.",
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "output_text", text: filler }],
      },
    ];
    const resolved = await runtime.providers.resolveConfig({
      ...((deployment.config ?? {}) as Record<string, unknown>),
    });
    const compacted = await runtime.compaction.compact(
      conversation as never[],
      resolved,
      { force: true, strategy: "native", trigger: "e2e" },
    );
    expect(compacted).toMatchObject({
      status: "completed",
      strategy: "native",
      metrics_json: {
        implementation: "responses_compact_v4",
        compaction_item_count: 1,
        retained_user_message_count: 2,
      },
    });
    expect(compacted.tokens_after!).toBeLessThan(compacted.tokens_before!);
    expect(
      compacted.projection!.items.some(
        (item) => (item as any).type === "compaction",
      ),
    ).toBe(true);

    const run = await runtime.runner.create({
      deploymentId: deployment.id,
      projection: compacted.projection as unknown as Record<string, unknown>,
      input: "What is the exact verification code? Reply with only the code.",
      limits: { max_turns: 3, max_duration_seconds: 180 },
    });
    await runtime.runner.processNext();
    const completed = await runtime.runner.publicRun(run.id);
    expect(completed.status, JSON.stringify(completed.error_json)).toBe(
      "completed",
    );
    expect(String(completed.output)).toContain(marker);
  });
});
