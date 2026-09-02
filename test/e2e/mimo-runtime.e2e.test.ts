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

const toolImplementationKey = `e2e.echo.${randomUUID()}`;
const sessionPhrase = `NEBULA-${randomUUID().slice(0, 8).toUpperCase()}`;
const toolValue = `TOOL-${randomUUID().slice(0, 8).toUpperCase()}`;
const mcpValue = `MCP-${randomUUID().slice(0, 8).toUpperCase()}`;
const skillMarker = `SKILL-${randomUUID().slice(0, 8).toUpperCase()}`;
const workspaceMarker = `WORKSPACE-${randomUUID().slice(0, 8).toUpperCase()}`;
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
let coreDeploymentId = "";
let mcpDeploymentId = "";
let compactionDeploymentId = "";
let workspaceDeploymentId = "";
let artifactRunId = "";

const recordId = (value: Record<string, unknown>) => String(value.id);
const outputText = (run: Record<string, unknown>) =>
  typeof run.output === "string" ? run.output : JSON.stringify(run.output);

async function runAndStream(
  deploymentId: string,
  input: string,
  conversation: Record<string, unknown>[] = [],
): Promise<RunResult> {
  const created = await client.createRun(
    {
      deployment_id: deploymentId,
      input,
      conversation,
      external_session_id: "business-owned-live-session",
      limits: { max_turns: 5, max_duration_seconds: 180 },
    },
    { idempotencyKey: crypto.randomUUID() },
  );
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
  sandbox?: boolean;
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
  compaction:
    enabled: true
    preserve_recent_tokens: 32
  ${input.sandbox ? "sandbox:\n    enabled: true\n    network_enabled: false" : ""}
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
        AGENT_DATABASE_URL: "pglite://:memory:",
        AGENT_ARTIFACT_ROOT: join(root, "artifacts"),
        AGENT_SKILL_ROOT: join(root, "skills"),
        AGENT_SANDBOX_ROOT: join(root, "sandboxes"),
        AGENT_CREDENTIAL_SECRET: "live-e2e-ephemeral-credential-secret",
        AGENT_WORKER_POLL_MS: "20",
        AGENT_SSE_HEARTBEAT_SECONDS: "1",
        AGENT_TRACING_DISABLED: "true",
        OMOIKANE_RUN_CONCURRENCY: "1",
      }),
      { startWorker: true },
    );
    app = await createApp(container);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as AddressInfo;
    client = new OmoikaneClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
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
    const skill = await client.importSkillBundle({
      files: [
        {
          path: "SKILL.md",
          content_base64: Buffer.from(skillSource).toString("base64"),
        },
      ],
    });
    const workspaceSkillSource = `---
name: Live Workspace Skill
slug: live-workspace-skill
description: Execute a bundled script through an explicitly bound Sandbox Tool.
omoikane:
  schema_version: 1
  workspace: required
  requires:
    tools: [sandbox_exec]
    commands: [node]
    network: false
  entrypoints:
    check:
      command: [node, .omoikane/skills/live-workspace-skill/scripts/check.mjs]
---

# Live Workspace Skill

For WORKSPACE_CHECK, call the declared entrypoint through sandbox_exec exactly once and report its stdout.
`;
    const workspaceSkill = await client.importSkillBundle({
      files: [
        {
          path: "SKILL.md",
          content_base64: Buffer.from(workspaceSkillSource).toString("base64"),
        },
        {
          path: "references/check.json",
          content_base64: Buffer.from(
            JSON.stringify({ marker: workspaceMarker }),
          ).toString("base64"),
        },
        {
          path: "scripts/check.mjs",
          content_base64: Buffer.from(
            "import fs from 'node:fs'; const value=JSON.parse(fs.readFileSync('.omoikane/skills/live-workspace-skill/references/check.json','utf8')); console.log(value.marker);\n",
          ).toString("base64"),
        },
      ],
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

    const core = await client.deployDefinition(
      agentDocument({
        slug: `mimo-core-${randomUUID()}`,
        name: "MiMo Core Live E2E",
        tools: [String(tool.slug)],
        skills: [recordId(skill.version)],
        instructions: `Follow the loaded skill exactly. If a user message begins with CALL_TOOL, call e2e_echo exactly once using the requested value, then return the marker and echoed value. For all other messages, do not call tools.`,
      }),
    );
    coreDeploymentId = recordId(core);

    const workspace = await client.deployDefinition(
      agentDocument({
        slug: `mimo-workspace-${randomUUID()}`,
        name: "MiMo Skill Workspace Live E2E",
        tools: ["sandbox-exec"],
        skills: [recordId(workspaceSkill.version)],
        sandbox: true,
        instructions:
          "When the user says WORKSPACE_CHECK, call sandbox_exec exactly once using command node and args [.omoikane/skills/live-workspace-skill/scripts/check.mjs]. After approval and the Tool result, reply with only stdout trimmed. Do not invent the marker.",
      }),
    );
    workspaceDeploymentId = recordId(workspace);

    const compaction = await client.deployDefinition(
      agentDocument({
        slug: `mimo-compaction-${randomUUID()}`,
        name: "MiMo Compaction Live E2E",
        instructions:
          "Keep exact session-only markers from the conversation. When asked for one, answer from session context with only the exact marker. Do not use tools or external context.",
      }),
    );
    compactionDeploymentId = recordId(compaction);

    const mcp = await client.deployDefinition(
      agentDocument({
        slug: `mimo-mcp-${randomUUID()}`,
        name: "MiMo MCP Live E2E",
        mcpServers: [recordId(mcpServer)],
        instructions:
          "When the user asks for MCP_CHECK, call mcp_echo exactly once with the supplied value, then reply with the complete tool result and nothing else.",
      }),
    );
    mcpDeploymentId = recordId(mcp);
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
    const skillRun = await runAndStream(coreDeploymentId, "SKILL_CHECK");
    expect(skillRun.output.trim()).toBe(skillMarker);

    const result = await runAndStream(
      coreDeploymentId,
      `CALL_TOOL with value ${toolValue}.`,
    );
    expect(result.output).toContain("FUNCTION_TOOL_OK");
    expect(result.output).toContain(toolValue);
    artifactRunId = recordId(result.run);
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
    const usage = await client.runUsage(recordId(result.run));
    expect(usage.data).toHaveLength(1);
    expect(usage.data[0]).toMatchObject({ reporting_status: "reported" });
    expect(Number(usage.data[0]?.total_tokens)).toBeGreaterThan(0);
    expect(usage.data[0]).not.toHaveProperty("estimated_cost");
    expect(usage.data[0]).not.toHaveProperty("currency");
  });

  it("executes a materialized Skill workspace after explicit approval", async () => {
    const created = await client.createRun(
      {
        deployment_id: workspaceDeploymentId,
        input: "WORKSPACE_CHECK",
        external_session_id: "business-owned-live-session",
        limits: { max_turns: 5, max_duration_seconds: 180 },
      },
      { idempotencyKey: crypto.randomUUID() },
    );
    const runId = recordId(created);
    const firstEvents: RuntimeEvent[] = [];
    for await (const event of client.streamRun(runId)) firstEvents.push(event);
    const waiting = await client.getRun(runId);
    expect(waiting.status).toBe("waiting_approval");
    const approvals = await client.request<{ data: Record<string, unknown>[] }>(
      "/v1/approvals?status=pending",
    );
    const approval = approvals.data.find((item) => item.run_id === runId);
    expect(approval).toBeDefined();
    await client.decideApproval(recordId(approval!), true, "live E2E approval");
    const cursor = firstEvents.at(-1)?.seq ?? 0;
    const resumedEvents: RuntimeEvent[] = [];
    for await (const event of client.streamRun(runId, cursor))
      resumedEvents.push(event);

    const completed = await client.getRun(runId);
    expect(completed.status, JSON.stringify(completed.error_json)).toBe(
      "completed",
    );
    expect(outputText(completed)).toContain(workspaceMarker);
    const executions = await client.request<{
      data: Record<string, unknown>[];
    }>(`/v1/runs/${runId}/tool-executions`);
    expect(executions.data).toHaveLength(1);
    expect(executions.data[0]).toMatchObject({
      tool_name: "sandbox_exec",
      status: "completed",
    });
    expect(
      String(
        (executions.data[0]?.output_json as Record<string, unknown>).stdout,
      ),
    ).toContain(workspaceMarker);
    const eventTypes = [...firstEvents, ...resumedEvents].map(
      (event) => event.type,
    );
    expect(eventTypes.filter((type) => type === "skill.prepared")).toHaveLength(
      1,
    );
    expect(eventTypes).toContain("sandbox.destroyed");
  }, 240_000);

  it("connects a stdio MCP server and completes a model-driven MCP call", async () => {
    const result = await runAndStream(
      mcpDeploymentId,
      `MCP_CHECK with value ${mcpValue}.`,
    );
    expect(result.output).toContain(`MCP_ECHO_OK:${mcpValue}`);
  });

  it("preserves a business-owned conversation fact through external compaction", async () => {
    const compressibleSessionNotes =
      "This is ordinary session-local background used to verify that a real checkpoint is smaller than its source. ".repeat(
        160,
      );
    const firstInput = `For this session only, record the exact verification phrase ${sessionPhrase}. Reply with only RECORDED.\n${compressibleSessionNotes}`;
    const first = await runAndStream(compactionDeploymentId, firstInput);
    expect(first.output).toContain("RECORDED");
    const conversation: Record<string, unknown>[] = [
      { role: "user", content: firstInput },
      ...((first.run.new_items ?? []) as Record<string, unknown>[]),
    ];
    const secondInput =
      "What is the exact session-only verification phrase? Reply with only the phrase.";
    const second = await runAndStream(
      compactionDeploymentId,
      secondInput,
      conversation,
    );
    expect(second.output).toContain(sessionPhrase);
    const canonical = [
      ...conversation,
      { role: "user", content: secondInput },
      ...((second.run.new_items ?? []) as Record<string, unknown>[]),
    ];
    const compacted = await client.compactContext({
      deployment_id: compactionDeploymentId,
      items: canonical,
      force: true,
      strategy: "portable",
    });
    expect(Number(compacted.tokens_before)).toBeGreaterThan(0);
    expect(String(compacted.summary_text)).toContain(sessionPhrase);
    expect(
      (compacted.metrics_json as Record<string, unknown>)
        .projection_within_low_watermark,
    ).toBe(true);
    const projection = compacted.projection as Record<string, unknown>;
    expect((projection.items as unknown[]).length).toBeLessThan(
      canonical.length,
    );

    const continued = await runAndStream(
      compactionDeploymentId,
      "After compaction, what is the exact session-only verification phrase? Reply with only the phrase.",
      projection.items as Record<string, unknown>[],
    );
    expect(continued.output).toContain(sessionPhrase);

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
      artifactRunId,
    );
    expect(await client.getArtifact(recordId(artifact))).toMatchObject({
      id: recordId(artifact),
      status: "active",
    });
    expect(
      (await client.listArtifacts({ runId: artifactRunId })).data.map(recordId),
    ).toContain(recordId(artifact));
    const downloaded = await client.downloadArtifact(recordId(artifact));
    expect(await downloaded.text()).toBe(content);
    await client.deleteArtifact(recordId(artifact));
    await expect(client.getArtifact(recordId(artifact))).rejects.toMatchObject({
      code: "not_found",
    });
  });
});
