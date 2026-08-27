import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../../src/api.js";
import { OmoikaneClient, type RuntimeEvent } from "../../src/client/index.js";
import { getSettings } from "../../src/config.js";
import { Container } from "../../src/container.js";
import { hashJson } from "../../src/serialization.js";

const tenantId = `mimo-compaction-100k-${randomUUID()}`;
const markers = {
  early: `EARLY-${randomUUID().slice(0, 8).toUpperCase()}`,
  middle: `MIDDLE-${randomUUID().slice(0, 8).toUpperCase()}`,
  late: `LATE-${randomUUID().slice(0, 8).toUpperCase()}`,
};

let root = "";
let container: Container | undefined;
let app: FastifyInstance | undefined;
let client: OmoikaneClient;
let agentVersionId = "";

const id = (value: Record<string, unknown>) => String(value.id);

describe.sequential("MiMo 100K context compaction", () => {
  beforeAll(async () => {
    if (!process.env.MIMO_API_KEY)
      throw new Error(
        "MIMO_API_KEY is required; put it in the ignored .env file or process environment",
      );
    root = await mkdtemp(join(tmpdir(), "omoikane-compaction-100k-"));
    container = await Container.create(
      getSettings({
        ...process.env,
        AGENT_ENVIRONMENT: "test",
        AGENT_DATABASE_URL: "pglite://:memory:",
        AGENT_ARTIFACT_ROOT: join(root, "artifacts"),
        AGENT_SKILL_ROOT: join(root, "skills"),
        AGENT_SANDBOX_ROOT: join(root, "sandboxes"),
        AGENT_RUN_STATE_SECRET: "compaction-100k-ephemeral-state-secret",
        AGENT_WORKER_POLL_MS: "20",
        AGENT_SSE_HEARTBEAT_SECONDS: "1",
        AGENT_TRACING_DISABLED: "true",
        AGENT_EMBEDDED_WORKER: "true",
      }),
      { startWorker: true },
    );
    app = await createApp(container);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as AddressInfo;
    client = new OmoikaneClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      tenantId,
      actorId: "compaction-100k-e2e",
    });
    const connection = await client.createProvider({
      name: "MiMo 100K Compaction E2E",
      provider: "xiaomi_mimo",
      endpoint_profile: "token_plan_cn",
      api_key_env: "MIMO_API_KEY",
    });
    const agent = await client.createAgentFromDefinition(`---
apiVersion: agentsdk/v1
kind: Agent
metadata:
  slug: mimo-compaction-100k
  name: MiMo Compaction 100K E2E
spec:
  provider:
    connection_id: ${id(connection)}
  model: mimo-v2.5
  model_settings:
    max_tokens: 1024
    reasoning_effort: none
  memory:
    enabled: false
    write_mode: disabled
  compaction:
    enabled: true
    preserve_recent_tokens: 0
  tracing:
    enabled: false
---

Use only the supplied session context. When asked for the early, middle and late validation markers, return one JSON object with keys early, middle and late and the exact marker values. Do not use tools or external memory.
`);
    agentVersionId = id(agent.version as Record<string, unknown>);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (container) await container.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("compacts more than 100K estimated tokens and preserves distributed facts", async () => {
    const session = await client.createSession({
      agent_version_id: agentVersionId,
      title: "MiMo 100K compaction",
    });
    const sessionId = id(session);
    const filler =
      "This is bounded filler for long-context compaction validation. ".repeat(
        90,
      );
    const items = Array.from({ length: 60 }, (_, index) => {
      const marker =
        index === 0
          ? ` The exact early validation marker is ${markers.early}.`
          : index === 30
            ? ` The exact middle validation marker is ${markers.middle}.`
            : index === 59
              ? ` The exact late validation marker is ${markers.late}.`
              : "";
      return {
        role: index % 2 === 0 ? "user" : "assistant",
        content: [
          {
            type: index % 2 === 0 ? "input_text" : "output_text",
            text: `Long context item ${index}.${marker}\n${filler}`,
          },
        ],
      };
    });
    await container!.sessions.appendTransactional(sessionId, items as never);
    const canonicalBefore = await client.request<{
      data: Record<string, unknown>[];
    }>(`/v1/sessions/${sessionId}/messages?include_compacted=true`);
    const canonicalHash = hashJson(canonicalBefore.data);
    const previewBefore = await client.request<Record<string, unknown>>(
      `/v1/sessions/${sessionId}/context-preview`,
    );
    expect(Number(previewBefore.raw_estimated_tokens)).toBeGreaterThan(100_000);

    const compacted = await client.compactSession(sessionId, {
      force: true,
      strategy: "portable",
    });
    expect(compacted.compacted).toBe(true);
    const compaction = compacted.compaction as Record<string, unknown>;
    const metrics = compaction.metrics_json as Record<string, unknown>;
    expect(Number(metrics.source_chunk_count)).toBeGreaterThan(1);
    expect(metrics.all_chunks_processed).toBe(true);
    expect(metrics.projection_within_low_watermark).toBe(true);
    expect(String(compaction.summary_text)).toContain(markers.early);
    expect(String(compaction.summary_text)).toContain(markers.middle);
    expect(String(compaction.summary_text)).toContain(markers.late);

    const canonicalAfter = await client.request<{
      data: Record<string, unknown>[];
    }>(`/v1/sessions/${sessionId}/messages?include_compacted=true`);
    expect(hashJson(canonicalAfter.data)).toBe(canonicalHash);
    const previewAfter = await client.request<Record<string, unknown>>(
      `/v1/sessions/${sessionId}/context-preview`,
    );
    expect(Number(previewAfter.effective_estimated_tokens)).toBeLessThan(
      Number(previewBefore.raw_estimated_tokens) * 0.2,
    );

    const created = await client.createRun({
      agent_version_id: agentVersionId,
      session_id: sessionId,
      input:
        "Return the exact early, middle and late validation markers as JSON.",
      limits: { max_turns: 3, max_duration_seconds: 300 },
    });
    const events: RuntimeEvent[] = [];
    for await (const event of client.streamRun(id(created))) events.push(event);
    const run = await client.getRun(id(created));
    expect(run.status, JSON.stringify(run.error_json)).toBe("completed");
    const output = JSON.stringify(run.output_json);
    expect(output).toContain(markers.early);
    expect(output).toContain(markers.middle);
    expect(output).toContain(markers.late);
    expect(events.map((event) => event.type)).not.toContain("memory.retrieved");
  });
});
