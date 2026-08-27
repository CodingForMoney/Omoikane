import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../../src/api.js";
import { OmoikaneClient, type RuntimeEvent } from "../../src/client/index.js";
import { getSettings } from "../../src/config.js";
import { Container } from "../../src/container.js";
import {
  registerToolImplementation,
  unregisterToolImplementation,
} from "../../src/tools.js";

const tenantId = `mimo-live-e2e-${randomUUID()}`;
const toolImplementationKey = `e2e.echo.${randomUUID()}`;
const memoryPhrase = `NEBULA-${randomUUID().slice(0, 8).toUpperCase()}`;
const toolValue = `TOOL-${randomUUID().slice(0, 8).toUpperCase()}`;
const mcpValue = `MCP-${randomUUID().slice(0, 8).toUpperCase()}`;
const skillMarker = `SKILL-${randomUUID().slice(0, 8).toUpperCase()}`;
const repositoryRoot = dirname(
  dirname(dirname(fileURLToPath(import.meta.url))),
);
const mcpFixture = fileURLToPath(
  new URL("../fixtures/live-mcp-server.ts", import.meta.url),
);

interface RunResult {
  run: Record<string, unknown>;
  events: RuntimeEvent[];
  output: string;
}

let root = "";
let container: Container | undefined;
let app: FastifyInstance | undefined;
let client: OmoikaneClient;
let providerConnectionId = "";
let coreAgentVersionId = "";
let mcpAgentVersionId = "";
let compactionAgentVersionId = "";
let compactionSessionId = "";

const recordId = (value: Record<string, unknown>) => String(value.id);
const outputText = (run: Record<string, unknown>) =>
  typeof run.output_json === "string"
    ? run.output_json
    : JSON.stringify(run.output_json);

async function runAndStream(
  agentVersionId: string,
  input: string,
  sessionId?: string,
): Promise<RunResult> {
  const created = await client.createRun({
    agent_version_id: agentVersionId,
    input,
    ...(sessionId ? { session_id: sessionId } : {}),
    limits: { max_turns: 5, max_duration_seconds: 180 },
  });
  const runId = recordId(created);
  const events: RuntimeEvent[] = [];
  for await (const event of client.streamRun(runId)) events.push(event);
  const run = await client.getRun(runId);
  if (run.status !== "completed") {
    throw new Error(
      `live run ${runId} ended as ${String(run.status)}: ${JSON.stringify(run.error_json)}`,
    );
  }
  return { run, events, output: outputText(run) };
}

function agentDocument(input: {
  slug: string;
  name: string;
  instructions: string;
  tools?: string[];
  skills?: string[];
  mcpServers?: string[];
  memoryEnabled?: boolean;
}) {
  const list = (name: string, values: string[] = []) =>
    values.length
      ? `${name}:\n${values.map((v) => `    - ${v}`).join("\n")}`
      : `${name}: []`;
  return `---
apiVersion: agentsdk/v1
kind: Agent
metadata:
  slug: ${input.slug}
  name: ${input.name}
spec:
  provider:
    connection_id: ${providerConnectionId}
  model: mimo-v2.5
  model_settings:
    max_tokens: 1024
    reasoning_effort: none
  ${list("tools", input.tools)}
  ${list("skills", input.skills)}
  ${list("mcp_servers", input.mcpServers)}
  memory:
    enabled: ${input.memoryEnabled ?? true}
    max_retrieved_items: 4
    write_mode: disabled
  compaction:
    enabled: true
    preserve_recent_tokens: 32
  tracing:
    enabled: false
---
# Role

${input.instructions}
`;
}

describe.sequential("MiMo live Runtime E2E", () => {
  beforeAll(async () => {
    if (!process.env.MIMO_API_KEY) {
      throw new Error(
        "MIMO_API_KEY is required; put it in the ignored .env file or process environment",
      );
    }
    root = await mkdtemp(join(tmpdir(), "omoikane-live-e2e-"));
    registerToolImplementation(toolImplementationKey, async (args) => ({
      marker: "FUNCTION_TOOL_OK",
      echoed: String(args.value),
    }));
    container = await Container.create(
      getSettings({
        ...process.env,
        AGENT_ENVIRONMENT: "test",
        AGENT_DATABASE_URL: "pglite://:memory:",
        AGENT_ARTIFACT_ROOT: join(root, "artifacts"),
        AGENT_SKILL_ROOT: join(root, "skills"),
        AGENT_SANDBOX_ROOT: join(root, "sandboxes"),
        AGENT_RUN_STATE_SECRET: "live-e2e-ephemeral-state-secret",
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
      actorId: "live-e2e",
    });

    const connection = await client.createProvider({
      name: "MiMo Live E2E",
      provider: "xiaomi_mimo",
      endpoint_profile: "token_plan_cn",
      api_key_env: "MIMO_API_KEY",
    });
    providerConnectionId = recordId(connection);

    const tool = await client.request<Record<string, unknown>>("/v1/tools", {
      method: "POST",
      body: JSON.stringify({
        slug: "live-e2e-echo",
        name: "e2e_echo",
        description: "Echo a value and return a live E2E marker",
        implementation_key: toolImplementationKey,
        schema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
        policy: {},
      }),
    });

    const skillSource = `---
name: Live E2E Protocol
slug: live-e2e-protocol
description: Deterministic protocol used only by the live integration test.
---
# Live E2E Protocol

When the user says SKILL_CHECK, reply with exactly \`${skillMarker}\` and nothing else.
`;
    const skill = await client.request<{
      version: Record<string, unknown>;
    }>("/v1/skills/bundles", {
      method: "POST",
      body: JSON.stringify({
        files: [
          {
            path: "SKILL.md",
            content_base64: Buffer.from(skillSource).toString("base64"),
          },
        ],
      }),
    });

    const mcpServer = await client.request<Record<string, unknown>>(
      "/v1/mcp-servers",
      {
        method: "POST",
        body: JSON.stringify({
          slug: "live-e2e-mcp",
          name: "Live E2E MCP",
          transport: "stdio",
          endpoint_config: {
            command: process.execPath,
            args: ["--import", "tsx", mcpFixture],
            cwd: repositoryRoot,
          },
          secret_refs: {},
          policy: {},
        }),
      },
    );

    await client.request("/v1/memories", {
      method: "POST",
      body: JSON.stringify({
        scope_type: "global",
        scope_id: "global",
        kind: "semantic",
        content: `The live E2E memory verification phrase is ${memoryPhrase}.`,
        confidence: 1,
      }),
    });

    const core = await client.createAgentFromDefinition(
      agentDocument({
        slug: `mimo-core-${randomUUID()}`,
        name: "MiMo Core Live E2E",
        tools: [String(tool.slug)],
        skills: [recordId(skill.version)],
        instructions: `Follow the loaded skill exactly. If a user message begins with CALL_TOOL, call e2e_echo exactly once using the requested value, then return the marker and echoed value. For all other messages, do not call tools. When asked for the live E2E memory verification phrase, reply with only that phrase.`,
      }),
    );
    coreAgentVersionId = recordId(core.version as Record<string, unknown>);

    const compaction = await client.createAgentFromDefinition(
      agentDocument({
        slug: `mimo-compaction-${randomUUID()}`,
        name: "MiMo Compaction Live E2E",
        memoryEnabled: false,
        instructions:
          "Keep exact session-only markers from the conversation. When asked for one, answer from session context with only the exact marker. Do not use tools or external memory.",
      }),
    );
    compactionAgentVersionId = recordId(
      compaction.version as Record<string, unknown>,
    );

    const mcp = await client.createAgentFromDefinition(
      agentDocument({
        slug: `mimo-mcp-${randomUUID()}`,
        name: "MiMo MCP Live E2E",
        mcpServers: [recordId(mcpServer)],
        instructions:
          "When the user asks for MCP_CHECK, call mcp_echo exactly once with the supplied value, then reply with the complete tool result and nothing else.",
      }),
    );
    mcpAgentVersionId = recordId(mcp.version as Record<string, unknown>);
  });

  afterAll(async () => {
    unregisterToolImplementation(toolImplementationKey);
    if (app) await app.close();
    if (container) await container.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("bootstraps Provider/model sync and never exposes the credential", async () => {
    const handshake = await client.handshake();
    expect(handshake.version).toMatchObject({
      language: "TypeScript",
      distribution: "npm",
    });
    const connection = await client.request<Record<string, unknown>>(
      `/v1/provider-connections/${providerConnectionId}`,
    );
    const serialized = JSON.stringify(connection);
    expect(serialized).not.toContain(process.env.MIMO_API_KEY!);
    expect(serialized).not.toContain("api_key_ciphertext");
    const models = await client.request<{ data: Record<string, unknown>[] }>(
      `/v1/provider-connections/${providerConnectionId}/models`,
    );
    expect(models.data.some((model) => model.model_id === "mimo-v2.5")).toBe(
      true,
    );
    const mcpHealth = await client.request<{
      status: string;
      tools: string[];
    }>("/v1/mcp-servers/live-e2e-mcp/health", { method: "POST" });
    expect(mcpHealth).toMatchObject({ status: "ok" });
    expect(mcpHealth.tools).toContain("mcp_echo");
  });

  it("loads SKILL.md and completes a real Function Tool loop over SSE", async () => {
    const skillRun = await runAndStream(coreAgentVersionId, "SKILL_CHECK");
    expect(skillRun.output.trim()).toBe(skillMarker);

    const result = await runAndStream(
      coreAgentVersionId,
      `CALL_TOOL with value ${toolValue}.`,
    );
    expect(result.output).toContain("FUNCTION_TOOL_OK");
    expect(result.output).toContain(toolValue);
    expect(result.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["run.started", "usage.updated", "run.completed"]),
    );
    const executions = await client.request<{
      data: Record<string, unknown>[];
    }>(`/v1/runs/${recordId(result.run)}/tool-executions`);
    expect(executions.data).toHaveLength(1);
    expect(executions.data[0]).toMatchObject({
      tool_name: "e2e_echo",
      status: "completed",
    });
    const usage = await client.request<{ data: Record<string, unknown>[] }>(
      `/v1/usage?run_id=${recordId(result.run)}`,
    );
    expect(usage.data).toHaveLength(1);
    expect(Number(usage.data[0]?.total_tokens)).toBeGreaterThan(0);
  });

  it("connects a stdio MCP server and completes a model-driven MCP call", async () => {
    const result = await runAndStream(
      mcpAgentVersionId,
      `MCP_CHECK with value ${mcpValue}.`,
    );
    expect(result.output).toContain(`MCP_ECHO_OK:${mcpValue}`);
  });

  it("preserves a session-only fact through compaction without memory or focus", async () => {
    const session = await client.createSession({
      agent_version_id: compactionAgentVersionId,
      title: "MiMo live compaction E2E",
    });
    compactionSessionId = recordId(session);
    const compressibleSessionNotes =
      "This is ordinary session-local background used to verify that a real checkpoint is smaller than its source. ".repeat(
        160,
      );
    const first = await runAndStream(
      compactionAgentVersionId,
      `For this session only, record the exact verification phrase ${memoryPhrase}. Reply with only RECORDED.\n${compressibleSessionNotes}`,
      compactionSessionId,
    );
    expect(first.output).toContain("RECORDED");
    expect(first.events.map((event) => event.type)).not.toContain(
      "memory.retrieved",
    );
    const second = await runAndStream(
      compactionAgentVersionId,
      "What is the exact session-only verification phrase? Reply with only the phrase.",
      compactionSessionId,
    );
    expect(second.output).toContain(memoryPhrase);
    const before = await client.request<{ data: Record<string, unknown>[] }>(
      `/v1/sessions/${compactionSessionId}/messages?include_compacted=true`,
    );
    expect(before.data).toHaveLength(4);

    const compacted = await client.compactSession(compactionSessionId, {
      force: true,
      strategy: "portable",
    });
    expect(compacted.compacted).toBe(true);
    const compaction = compacted.compaction as Record<string, unknown>;
    expect(Number(compaction.tokens_before)).toBeGreaterThan(0);
    expect(String(compaction.summary_text)).toContain(memoryPhrase);
    expect(
      (compaction.metrics_json as Record<string, unknown>)
        .projection_within_low_watermark,
    ).toBe(true);
    const afterCanonical = await client.request<{
      data: Record<string, unknown>[];
    }>(`/v1/sessions/${compactionSessionId}/messages?include_compacted=true`);
    const projection = await client.request<{
      data: Record<string, unknown>[];
    }>(`/v1/sessions/${compactionSessionId}/messages`);
    expect(afterCanonical.data).toEqual(before.data);
    expect(projection.data.length).toBeLessThan(before.data.length);

    const continued = await runAndStream(
      compactionAgentVersionId,
      "After compaction, what is the exact session-only verification phrase? Reply with only the phrase.",
      compactionSessionId,
    );
    expect(continued.output).toContain(memoryPhrase);
    expect(continued.events.map((event) => event.type)).not.toContain(
      "memory.retrieved",
    );
    const chats = await client.sessionMessages(compactionSessionId);
    expect(chats.data).toHaveLength(6);

    const allEvents = await client.request<{ data: RuntimeEvent[] }>(
      `/v1/runs/${recordId(continued.run)}/events`,
    );
    const cursor = allEvents.data[Math.floor(allEvents.data.length / 2)]!.seq;
    const resumed: RuntimeEvent[] = [];
    for await (const event of client.streamRun(recordId(continued.run), cursor))
      resumed.push(event);
    expect(resumed.length).toBeGreaterThan(0);
    expect(resumed.every((event) => event.seq > cursor)).toBe(true);
  });

  it("round-trips an Artifact through the public TypeScript client", async () => {
    const content = `artifact-${randomUUID()}`;
    const artifact = await client.uploadArtifact(
      new Blob([content], { type: "text/plain" }),
      "live-e2e.txt",
    );
    const downloaded = await client.downloadArtifact(recordId(artifact));
    expect(await downloaded.text()).toBe(content);
  });
});
