import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/api.js";
import { OmoikaneClient } from "../src/client/index.js";
import { applyRuntimeDeployment } from "../src/deployment.js";
import type { Container } from "../src/container.js";
import { testContainer } from "./helpers.js";

let container: Container | undefined;
let closeContainer: (() => Promise<void>) | undefined;
let closeApp: (() => Promise<void>) | undefined;
let projectRoot: string | undefined;

afterEach(async () => {
  await closeApp?.();
  await closeContainer?.();
  if (projectRoot) await rm(projectRoot, { recursive: true, force: true });
  container = undefined;
  closeContainer = undefined;
  closeApp = undefined;
  projectRoot = undefined;
});

describe("RuntimeDeployment apply", () => {
  it("applies Providers and immutable resources idempotently", async () => {
    const test = await testContainer();
    container = test.container;
    closeContainer = test.close;
    const app = await createApp(container);
    closeApp = () => app.close();
    const baseUrl = "http://runtime.test";
    const fetcher: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const body = ["GET", "HEAD"].includes(request.method)
        ? undefined
        : await request.text();
      const response: any = await app.inject({
        method: request.method as any,
        url: `${new URL(request.url).pathname}${new URL(request.url).search}`,
        headers: Object.fromEntries(request.headers),
        payload: body,
      });
      return new Response(response.rawPayload, {
        status: response.statusCode,
        headers: response.headers as HeadersInit,
      });
    };
    const client = new OmoikaneClient({
      baseUrl,
      timeoutMs: 5_000,
      fetch: fetcher,
    });

    projectRoot = await mkdtemp(join(tmpdir(), "omoikane-deployment-"));
    await mkdir(join(projectRoot, "agents"));
    await mkdir(join(projectRoot, "skills", "review"), { recursive: true });
    await mkdir(join(projectRoot, "tools"));
    await writeFile(
      join(projectRoot, "tools", "lookup.yaml"),
      `slug: business-lookup
name: business_lookup
description: Read one business object
implementation_key: business.lookup
schema:
  type: object
  properties:
    id:
      type: string
  required: [id]
  additionalProperties: false
policy:
  requires_approval: false
  side_effecting: false
`,
    );
    await writeFile(
      join(projectRoot, "skills", "review", "SKILL.md"),
      `---
name: Review
slug: review
description: Review supplied evidence
---

Review the supplied evidence carefully.
`,
    );
    await writeFile(
      join(projectRoot, "agents", "assistant.md"),
      `---
apiVersion: agentsdk/v1
kind: Agent
metadata:
  slug: assistant
  name: Assistant
spec:
  model: test-model
---

Answer carefully.
`,
    );
    await writeFile(
      join(projectRoot, "omoikane.yaml"),
      `apiVersion: omoikane.io/v1
kind: RuntimeDeployment
project: integration-test
providers:
  primary:
    name: Local Test Provider
    provider: custom_openai_compatible
    custom_base_url: ${baseUrl}/v1
    custom_protocol: responses
    api_key_env: OMOIKANE_TEST_PROVIDER_KEY
resources:
  tools:
    lookup: tools/lookup.yaml
  skills:
    review: skills/review
  mcpServers: {}
  agents:
    assistant:
      path: agents/assistant.md
      provider: primary
      tools: [lookup]
      skills: [review]
`,
    );

    process.env.OMOIKANE_TEST_PROVIDER_KEY = "local-test-key";
    try {
      const first = await applyRuntimeDeployment(
        client,
        join(projectRoot, "omoikane.yaml"),
        { syncProviderModels: false },
      );
      expect(first.providers.primary?.action).toBe("created");
      expect(first.tools.lookup?.action).toBe("created");
      expect(first.skills.review?.action).toBe("created");
      expect(first.agents.assistant?.action).toBe("created");

      const second = await applyRuntimeDeployment(
        client,
        join(projectRoot, "omoikane.yaml"),
        { syncProviderModels: false },
      );
      expect(second.providers.primary?.action).toBe("reused");
      expect(second.tools.lookup?.action).toBe("reused");
      expect(second.skills.review?.action).toBe("reused");
      expect(second.agents.assistant?.action).toBe("reused");
      expect(second.agents.assistant?.id).toBe(first.agents.assistant?.id);
    } finally {
      delete process.env.OMOIKANE_TEST_PROVIDER_KEY;
    }
  });
});
