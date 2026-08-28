import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  modelResponse,
} from "@openai/agents/testing";
import type { Container } from "../src/container.js";
import { createApp } from "../src/api.js";
import { publishedAgent, testContainer } from "./helpers.js";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const stdioFixture = fileURLToPath(
  new URL("./fixtures/live-mcp-server.ts", import.meta.url),
);
const httpFixture = fileURLToPath(
  new URL("./fixtures/http-mcp-server.ts", import.meta.url),
);

let container: Container | undefined;
let cleanup: (() => Promise<void>) | undefined;
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGTERM");
  await cleanup?.();
  container = undefined;
  cleanup = undefined;
  delete process.env.MCP_TEST_VALUE;
});

const stdioInput = (
  slug: string,
  policy: Record<string, unknown> = {},
  secretRefs: Record<string, string> = {},
) => ({
  slug,
  name: `MCP ${slug}`,
  transport: "stdio",
  endpoint_config: {
    command: process.execPath,
    args: ["--import", "tsx", stdioFixture],
    cwd: repositoryRoot,
  },
  secret_refs: secretRefs,
  policy,
});

async function startHttpFixture(mode: "streamable_http" | "sse") {
  const child = spawn(process.execPath, ["--import", "tsx", httpFixture], {
    cwd: repositoryRoot,
    env: { ...process.env, MCP_HTTP_MODE: mode, MCP_HTTP_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return new Promise<number>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      reject(new Error(`HTTP MCP fixture did not start: ${stderr}`));
    }, 5_000);
    child.stdout!.on("data", (chunk) => {
      stdout += String(chunk);
      const line = stdout.split("\n")[0];
      if (/^\d+$/.test(line ?? "")) {
        clearTimeout(timeout);
        resolve(Number(line));
      }
    });
    child.stderr!.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`HTTP MCP fixture exited ${code}: ${stderr}`));
    });
  });
}

describe("Runtime-managed MCP", () => {
  it("validates typed configuration and enforces allowlists at inspection and call boundaries", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    process.env.MCP_TEST_VALUE = "mcp-test-secret-never-returned";

    await expect(
      container.mcp.create({
        ...stdioInput("invalid-policy"),
        policy: { arbitrary_policy_blob: true },
      }),
    ).rejects.toThrow("unsupported fields");

    const record = await container.mcp.create(
      stdioInput(
        "stdio-policy",
        { allowed_tools: ["mcp_echo"] },
        { "env.MCP_TEST_SECRET": "MCP_TEST_VALUE" },
      ),
    );
    const health = await container.mcp.health(record.id);
    expect(health).toMatchObject({
      status: "ok",
      discovered_tool_count: 5,
      effective_tool_count: 1,
      tools: ["mcp_echo"],
    });
    expect(health.blocked_tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "mcp_secret_probe" }),
      ]),
    );
    expect(JSON.stringify(health)).not.toContain(process.env.MCP_TEST_VALUE);

    const result = await container.mcp.testCall(record.id, "mcp_echo", {
      value: "policy-ok",
    });
    expect(JSON.stringify(result.output)).toContain("MCP_ECHO_OK:policy-ok");
    await expect(
      container.mcp.testCall(record.id, "mcp_secret_probe", {}),
    ).rejects.toThrow("blocked by policy");
  }, 20_000);

  it("rejects timed-out and oversized MCP outputs without storing their content", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const record = await container.mcp.create(
      stdioInput("stdio-limits", {
        allowed_tools: ["mcp_slow", "mcp_large"],
        call_timeout_ms: 50,
        max_output_bytes: 256,
      }),
    );
    await expect(
      container.mcp.testCall(record.id, "mcp_slow", { delay_ms: 500 }),
    ).rejects.toThrow("timed out");
    await expect(
      container.mcp.testCall(record.id, "mcp_large", { bytes: 2_000 }),
    ).rejects.toThrow("limit is 256 bytes");
  }, 20_000);

  it("freezes MCP tools and policy per Run and resumes approval through SDK RunState", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const mcp = await container.mcp.create(
      stdioInput("approval-mcp", {
        allowed_tools: ["mcp_approval_action"],
        approval: { mode: "selected", tools: ["mcp_approval_action"] },
        side_effecting_tools: ["mcp_approval_action"],
      }),
    );
    const model = new ScriptedModel([
      modelResponse([
        functionCall(
          "mcp_approval_action",
          { value: "durable" },
          { callId: "mcp-approval-call-1" },
        ),
      ]),
      modelResponse([assistantMessage("MCP approval completed")]),
    ]);
    const fixture = await publishedAgent(container, {
      model,
      mcpServers: [mcp.slug],
    });
    const run = await container.runner.create({
      deploymentId: fixture.version.id,
      input: "Perform the MCP approval action",
    });

    await container.runner.processNext();
    expect((await container.runner.get(run.id)).status).toBe(
      "waiting_approval",
    );
    const before = (
      await container.db.query<Record<string, unknown>>(
        "SELECT * FROM mcp_run_bindings WHERE run_id=$1",
        [run.id],
      )
    ).rows[0]!;
    expect(before.tools_json).toEqual([
      expect.objectContaining({ name: "mcp_approval_action" }),
    ]);

    await container.mcp.update(mcp.id, {
      policy: {
        allowed_tools: ["mcp_echo"],
        approval: { mode: "never" },
      },
    });
    const approval = (
      await container.db.query<Record<string, unknown>>(
        "SELECT * FROM approvals WHERE run_id=$1",
        [run.id],
      )
    ).rows[0]!;
    await container.runner.decideApproval(String(approval.id), "approved");
    await container.runner.processNext();

    const completed = await container.runner.publicRun(run.id);
    expect(completed).toMatchObject({
      status: "completed",
      output: "MCP approval completed",
    });
    const after = (
      await container.db.query<Record<string, unknown>>(
        "SELECT * FROM mcp_run_bindings WHERE run_id=$1",
        [run.id],
      )
    ).rows[0]!;
    expect(after.fingerprint).toBe(before.fingerprint);
    const executions = await container.tools.executions(run.id);
    expect(executions).toEqual([
      expect.objectContaining({
        source_type: "mcp",
        source_id: mcp.id,
        tool_name: "mcp_approval_action",
        status: "completed",
        side_effecting: true,
      }),
    ]);
  }, 30_000);

  it("holds ambiguous side effects for reconciliation and resumes the same approved call", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const mcp = await container.mcp.create(
      stdioInput("reconcile-mcp", {
        allowed_tools: ["mcp_slow"],
        side_effecting_tools: ["mcp_slow"],
        call_timeout_ms: 50,
      }),
    );
    const model = new ScriptedModel([
      modelResponse([
        functionCall(
          "mcp_slow",
          { delay_ms: 500 },
          { callId: "mcp-reconcile-call-1" },
        ),
      ]),
      modelResponse([assistantMessage("Reconciled MCP call completed")]),
    ]);
    const fixture = await publishedAgent(container, {
      model,
      mcpServers: [mcp.slug],
    });
    const run = await container.runner.create({
      deploymentId: fixture.version.id,
      input: "Perform the slow side effect",
    });
    await container.runner.processNext();
    expect((await container.runner.get(run.id)).status).toBe(
      "waiting_approval",
    );
    const approval = (
      await container.db.query<Record<string, unknown>>(
        "SELECT * FROM approvals WHERE run_id=$1",
        [run.id],
      )
    ).rows[0]!;
    await container.runner.decideApproval(String(approval.id), "approved");
    await container.runner.processNext();
    expect((await container.runner.get(run.id)).status).toBe(
      "waiting_reconciliation",
    );
    const execution = (await container.tools.executions(run.id))[0]!;
    expect(execution).toMatchObject({
      source_type: "mcp",
      status: "unknown",
      side_effecting: true,
    });

    await container.tools.resolveExecution(String(execution.id), {
      status: "completed",
      output: { type: "text", text: "MCP_SLOW_CONFIRMED" },
      reason: "verified in the external system",
    });
    expect((await container.runner.get(run.id)).status).toBe("queued");
    await container.runner.processNext();
    expect(await container.runner.publicRun(run.id)).toMatchObject({
      status: "completed",
      output: "Reconciled MCP call completed",
    });
    expect(model.calls).toHaveLength(2);
  }, 30_000);

  it("intersects Agent overrides and rejects Function/MCP tool-name collisions", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const mcp = await container.mcp.create(
      stdioInput("override-mcp", {
        allowed_tools: ["mcp_echo"],
        call_timeout_ms: 10_000,
        max_output_bytes: 10_000,
      }),
    );
    const model = new ScriptedModel([
      modelResponse([assistantMessage("not executed")]),
    ]);
    const narrowed = await publishedAgent(container, {
      model,
      mcpServers: [
        {
          server_id: mcp.id,
          policy_override: {
            allowed_tools: ["mcp_echo", "mcp_large"],
            approval: { mode: "always" },
            call_timeout_ms: 2_000,
            max_output_bytes: 1_000,
          },
        },
      ],
    });
    const run = await container.runner.create({
      deploymentId: narrowed.version.id,
      input: "inspect",
    });
    const built = await container.factory.build(narrowed.version.id, {
      run_id: run.id,
      deployment_id: narrowed.version.id,
    });
    await built.close();
    const binding = (
      await container.db.query<Record<string, unknown>>(
        "SELECT * FROM mcp_run_bindings WHERE run_id=$1",
        [run.id],
      )
    ).rows[0]!;
    expect(binding.policy_json).toMatchObject({
      allowed_tools: ["mcp_echo"],
      approval: { mode: "always" },
      call_timeout_ms: 2_000,
      max_output_bytes: 1_000,
    });

    const collision = await container.tools.create({
      slug: "mcp-echo-collision",
      name: "mcp_echo",
      description: "Deliberately collide with MCP",
      implementation_key: "builtin.artifact_create",
      schema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    });
    const collided = await publishedAgent(container, {
      model,
      tools: [collision.id],
      mcpServers: [mcp.id],
    });
    const collidedRun = await container.runner.create({
      deploymentId: collided.version.id,
      input: "collision",
    });
    await expect(
      container.factory.build(collided.version.id, {
        run_id: collidedRun.id,
        deployment_id: collided.version.id,
      }),
    ).rejects.toThrow("tool name collision");
  }, 30_000);

  it("journals oversized Agent MCP output by size and hash but not content", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const mcp = await container.mcp.create(
      stdioInput("oversized-agent-mcp", {
        allowed_tools: ["mcp_large"],
        max_output_bytes: 256,
      }),
    );
    const model = new ScriptedModel([
      modelResponse([
        functionCall(
          "mcp_large",
          { bytes: 2_000 },
          { callId: "mcp-large-call-1" },
        ),
      ]),
    ]);
    const fixture = await publishedAgent(container, {
      model,
      mcpServers: [mcp.id],
    });
    const run = await container.runner.create({
      deploymentId: fixture.version.id,
      input: "return a large result",
    });
    await container.runner.processNext();
    expect((await container.runner.get(run.id)).status).toBe("failed");
    const execution = (await container.tools.executions(run.id))[0]!;
    expect(execution).toMatchObject({
      status: "failed",
      output_json: null,
      output_size: expect.anything(),
      output_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(Number(execution.output_size)).toBeGreaterThan(2_000);
    expect(JSON.stringify(execution)).not.toContain("x".repeat(100));
  }, 30_000);

  it.each(["streamable_http", "sse"] as const)(
    "connects and calls %s MCP servers",
    async (transport) => {
      const test = await testContainer();
      container = test.container;
      cleanup = test.close;
      const port = await startHttpFixture(transport);
      const record = await container.mcp.create({
        slug: `http-${transport.replace("_", "-")}`,
        name: `HTTP ${transport}`,
        transport,
        endpoint_config: {
          url: `http://127.0.0.1:${port}/${transport === "sse" ? "sse" : "mcp"}`,
        },
        secret_refs: {},
        policy: { allowed_tools: ["http_echo"] },
      });
      expect(await container.mcp.health(record.id)).toMatchObject({
        status: "ok",
        tools: ["http_echo"],
      });
      const called = await container.mcp.testCall(record.id, "http_echo", {
        value: transport,
      });
      expect(JSON.stringify(called.output)).toContain(`HTTP_ECHO:${transport}`);
    },
    30_000,
  );

  it("exposes MCP CRUD, health, tools, and safe test-call APIs", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const app = await createApp(container);
    try {
      const created = await app.inject({
        method: "POST",
        url: "/v1/mcp-servers",
        payload: stdioInput("api-mcp", { allowed_tools: ["mcp_echo"] }),
      });
      expect(created.statusCode).toBe(201);
      const id = created.json().id as string;
      expect(
        (await app.inject({ method: "GET", url: `/v1/mcp-servers/${id}` }))
          .statusCode,
      ).toBe(200);
      const tools = await app.inject({
        method: "GET",
        url: `/v1/mcp-servers/${id}/tools`,
      });
      expect(tools.json().data).toEqual([
        expect.objectContaining({ name: "mcp_echo" }),
      ]);
      const called = await app.inject({
        method: "POST",
        url: `/v1/mcp-servers/${id}/tools/mcp_echo/call`,
        payload: { arguments: { value: "api" } },
      });
      expect(called.statusCode).toBe(200);
      expect(JSON.stringify(called.json().output)).toContain("MCP_ECHO_OK:api");
      expect(
        (await app.inject({ method: "DELETE", url: `/v1/mcp-servers/${id}` }))
          .statusCode,
      ).toBe(204);
    } finally {
      await app.close();
    }
  }, 30_000);
});
