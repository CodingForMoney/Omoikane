import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../src/api.js";
import { API_CONTRACTS } from "../src/contracts.js";
import type { ApiRouteContract } from "../src/contracts.js";
import type { Container } from "../src/container.js";
import { publishedAgent, testContainer } from "./helpers.js";

let app: FastifyInstance | undefined;
let container: Container | undefined;
let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await app?.close();
  await cleanup?.();
  app = undefined;
  container = undefined;
  cleanup = undefined;
});

async function setup() {
  const test = await testContainer();
  container = test.container;
  cleanup = test.close;
  app = await createApp(container);
  return { app, container };
}

function expectValidation(response: {
  statusCode: number;
  json(): Record<string, any>;
}) {
  expect(response.statusCode).toBe(422);
  const payload = response.json();
  expect(payload).toMatchObject({
    error: {
      code: "invalid_request",
      message: "request validation failed",
      request_id: expect.any(String),
      details: { issues: expect.any(Array) },
    },
  });
  return payload.error.details.issues as Array<Record<string, string>>;
}

describe("REST contract", () => {
  it("returns stable, value-free validation errors", async () => {
    const { app } = await setup();
    const secret = "contract-test-secret-must-never-be-returned";
    const response = await app.inject({
      method: "POST",
      url: "/v1/provider-connections",
      payload: {
        name: "Invalid Provider",
        provider: "xiaomi_mimo",
        api_key: secret,
        unexpected: true,
      },
    });
    const issues = expectValidation(response);
    expect(issues.some((issue) => issue.code === "unrecognized_keys")).toBe(
      true,
    );
    expect(response.body).not.toContain(secret);
    expect(response.body).not.toContain('api_key":"');

    const malformedSecret = "malformed-secret-must-never-be-returned";
    const malformed = await app.inject({
      method: "POST",
      url: "/v1/provider-connections",
      headers: { "content-type": "application/json" },
      payload: `{"api_key":"${malformedSecret}`,
    });
    const malformedIssues = expectValidation(malformed);
    expect(malformedIssues).toEqual([
      {
        path: "$",
        code: "invalid_json",
        message: "malformed JSON request body",
      },
    ]);
    expect(malformed.body).not.toContain(malformedSecret);
  });

  it.each([
    {
      name: "missing required Run field",
      request: {
        method: "POST",
        url: "/v1/runs",
        payload: { input: "hello" },
      },
      path: "deployment_id",
    },
    {
      name: "string boolean",
      request: {
        method: "POST",
        url: "/v1/context/compact",
        payload: {
          deployment_id: "deployment",
          items: [],
          dry_run: "false",
        },
      },
      path: "dry_run",
    },
    {
      name: "invalid event cursor",
      request: {
        method: "GET",
        url: "/v1/runs/run/events?after=-1",
      },
      path: "after",
    },
    {
      name: "missing artifact owner",
      request: { method: "POST", url: "/v1/artifacts" },
      path: "run_id",
    },
    {
      name: "non-object MCP arguments",
      request: {
        method: "POST",
        url: "/v1/mcp-servers/server/tools/tool/call",
        payload: { arguments: ["not", "an", "object"] },
      },
      path: "arguments",
    },
    {
      name: "unexpected body on bodyless command",
      request: {
        method: "POST",
        url: "/v1/runs/run/cancel",
        payload: { force: true },
      },
      path: "$",
    },
    {
      name: "unexpected query parameter",
      request: { method: "GET", url: "/healthz?unexpected=1" },
      path: "$",
    },
  ])("rejects $name before service execution", async ({ request, path }) => {
    const { app } = await setup();
    const issues = expectValidation(await app.inject(request as any));
    expect(issues.some((issue) => issue.path === path)).toBe(true);
  });

  it("accepts dynamic business payloads inside strict envelopes", async () => {
    const { app, container } = await setup();
    const fixture = await publishedAgent(container);
    const tool = await app.inject({
      method: "POST",
      url: "/v1/tools",
      payload: {
        slug: "contract-dynamic-tool",
        name: "contract_dynamic_tool",
        description: "Verifies that JSON Schema remains business-defined",
        implementation_key: "business.contract_dynamic_tool",
        schema: {
          type: "object",
          properties: {
            business_payload: {
              type: "object",
              "x-business-extension": { arbitrary: [1, 2, 3] },
            },
          },
        },
      },
    });
    expect(tool.statusCode).toBe(201);

    const run = await app.inject({
      method: "POST",
      url: "/v1/runs",
      payload: {
        deployment_id: fixture.version.id,
        input: "hello",
        context: {
          business: { nested: { custom: ["anything"] } },
        },
      },
    });
    expect(run.statusCode).toBe(202);

    const unknownEnvelope = await app.inject({
      method: "POST",
      url: "/v1/runs",
      payload: {
        deployment_id: fixture.version.id,
        input: "hello",
        business: { must_be_inside_context: true },
      },
    });
    expectValidation(unknownEnvelope);
  });

  it("publishes every route from the same contract as OpenAPI", async () => {
    const { app } = await setup();
    const response = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(response.statusCode).toBe(200);
    const document = response.json();
    expect(document.openapi).toBe("3.1.0");

    const operations = Object.values(document.paths).flatMap((path: any) =>
      Object.keys(path),
    );
    expect(operations).toHaveLength(Object.keys(API_CONTRACTS).length);
    expect(
      document.paths["/v1/runs"].post.requestBody.content["application/json"]
        .schema.additionalProperties,
    ).toBe(false);
    expect(
      document.paths["/v1/runs"].post.responses["422"].content[
        "application/json"
      ].schema,
    ).toBeTruthy();
    expect(
      document.paths["/v1/runs/{runId}/cancel"].post.requestBody.required,
    ).toBe(false);

    for (const rawContract of Object.values(API_CONTRACTS)) {
      const contract: ApiRouteContract = rawContract;
      if (
        ["post", "patch"].includes(contract.method) &&
        contract.requestContentType !== "multipart/form-data"
      )
        expect(contract).toHaveProperty("body");
      if (contract.path.includes(":"))
        expect(contract).toHaveProperty("params");
    }
  });

  it("keeps both documented and legacy MCP request forms compatible", async () => {
    const { app } = await setup();
    const documented = await app.inject({
      method: "POST",
      url: "/v1/mcp-servers",
      payload: {
        apiVersion: "omoikane/v1",
        kind: "McpServer",
        metadata: { slug: "contract-doc-mcp", name: "Contract Doc MCP" },
        spec: {
          transport: "stdio",
          endpoint: { command: process.execPath, args: ["--version"] },
          execution_mode: "runtime",
        },
      },
    });
    expect(documented.statusCode).toBe(201);

    const legacy = await app.inject({
      method: "POST",
      url: "/v1/mcp-servers",
      payload: {
        slug: "contract-legacy-mcp",
        name: "Contract Legacy MCP",
        transport: "stdio",
        endpoint_config: { command: process.execPath, args: ["--version"] },
      },
    });
    expect(legacy.statusCode).toBe(201);
  });
});
