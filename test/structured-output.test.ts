import { afterEach, describe, expect, it } from "vitest";
import {
  ScriptedModel,
  assistantMessage,
  modelResponse,
} from "@openai/agents/testing";
import type { Container } from "../src/container.js";
import { publishedAgent, testContainer } from "./helpers.js";

let container: Container | undefined;
let cleanup: (() => Promise<void>) | undefined;

const outputSchema = {
  type: "object",
  properties: {
    answer: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["answer", "confidence"],
  additionalProperties: false,
};

afterEach(async () => {
  await cleanup?.();
  container = undefined;
  cleanup = undefined;
});

describe("structured output contract", () => {
  it("uses native SDK strict output and validates the result locally", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const model = new ScriptedModel([
      modelResponse([
        assistantMessage(JSON.stringify({ answer: "native", confidence: 0.9 })),
      ]),
    ]);
    const fixture = await publishedAgent(container, {
      provider: "openai",
      modelId: "gpt-5.4",
      model,
      outputSchema,
    });
    const created = await container.runner.create({
      deploymentId: fixture.version.id,
      input: "Return a structured answer",
    });

    await container.runner.processNext();

    const completed = await container.runner.publicRun(created.id);
    expect(completed.status).toBe("completed");
    expect(completed.output).toEqual({ answer: "native", confidence: 0.9 });
    expect(model.firstCall?.request.outputType).toEqual({
      type: "json_schema",
      name: "agent_output",
      strict: true,
      schema: outputSchema,
    });
    expect(model.firstCall?.request.systemInstructions).not.toContain(
      "<structured_output_contract>",
    );
    const events = await container.events.list(created.id);
    const event = events.find(
      (candidate) => candidate.type === "run.completed",
    );
    expect(event?.payload_json).toMatchObject({
      structured_output_validated: true,
      structured_output_mode: "native",
    });
    const agentEvent = events.find(
      (candidate) => candidate.type === "agent.completed",
    );
    expect(agentEvent?.payload_json).toMatchObject({
      output_available: false,
      output_validation: "pending",
    });
    expect(agentEvent?.payload_json).not.toHaveProperty("output");
    const messageEvent = events.find(
      (candidate) => candidate.type === "message_output_created",
    );
    expect(messageEvent?.payload_json).toMatchObject({
      item_available: false,
      output_validation: "pending",
    });
    expect(messageEvent?.payload_json).not.toHaveProperty("item");
  });

  it("uses a prompt fallback without pretending the Provider supports strict output", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const model = new ScriptedModel([
      modelResponse([
        assistantMessage(
          JSON.stringify({ answer: "prompt", confidence: 0.75 }),
        ),
      ]),
    ]);
    const fixture = await publishedAgent(container, {
      model,
      outputSchema,
    });
    const created = await container.runner.create({
      deploymentId: fixture.version.id,
      input: "Return a structured answer",
    });

    await container.runner.processNext();

    const completed = await container.runner.publicRun(created.id);
    expect(completed.status).toBe("completed");
    expect(completed.output).toEqual({ answer: "prompt", confidence: 0.75 });
    expect(model.firstCall?.request.outputType).toBe("text");
    expect(model.firstCall?.request.systemInstructions).toContain(
      "<structured_output_contract>",
    );
    expect(model.firstCall?.request.systemInstructions).toContain(
      '<json_schema>{"type":"object"',
    );
    expect(model.firstCall?.request.systemInstructions).toContain(
      '"confidence"',
    );
    const completedEvent = (await container.events.list(created.id)).find(
      (candidate) => candidate.type === "run.completed",
    );
    expect(completedEvent?.payload_json).toMatchObject({
      structured_output_validated: true,
      structured_output_mode: "prompt",
    });
  });

  it("fails malformed JSON once without repair or retry", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const model = new ScriptedModel([
      modelResponse([assistantMessage("```json\nnot-json\n```")]),
    ]);
    const fixture = await publishedAgent(container, { model, outputSchema });
    const created = await container.runner.create({
      deploymentId: fixture.version.id,
      input: "Return malformed output",
    });

    await container.runner.processNext();

    const failed = await container.runner.get(created.id);
    expect(failed.status).toBe("failed");
    expect(failed.output_json).toBeNull();
    expect(failed.error_json).toMatchObject({
      code: "structured_output_invalid",
      message: "model output is not valid JSON",
      details: { mode: "prompt", stage: "parse" },
    });
    expect(model.calls).toHaveLength(1);
  });

  it("rejects schema mismatches even when native SDK parsing accepts the JSON", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const model = new ScriptedModel([
      modelResponse([assistantMessage(JSON.stringify({ wrong: 1 }))]),
    ]);
    const fixture = await publishedAgent(container, {
      provider: "openai",
      modelId: "gpt-5.4",
      model,
      outputSchema,
    });
    const created = await container.runner.create({
      deploymentId: fixture.version.id,
      input: "Return the wrong shape",
    });

    await container.runner.processNext();

    const failed = await container.runner.get(created.id);
    expect(failed.status).toBe("failed");
    expect(failed.error_json).toMatchObject({
      code: "structured_output_invalid",
      message: "model output does not match output_schema",
      details: { mode: "native", stage: "schema" },
    });
    const details = failed.error_json?.details as {
      issues: Array<{ keyword: string }>;
    };
    expect(details.issues.map((issue) => issue.keyword)).toEqual(
      expect.arrayContaining(["required", "additionalProperties"]),
    );
    expect(model.calls).toHaveLength(1);
  });

  it("rejects invalid or non-object schemas when the Agent is deployed", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;

    await expect(
      container.definitions.deploy({
        config: {
          name: "Array output",
          instructions: "Return an array",
          output_schema: { type: "array", items: { type: "string" } },
        },
      }),
    ).rejects.toThrow('output_schema root type must be exactly "object"');

    await expect(
      container.definitions.deploy({
        config: {
          name: "Malformed schema",
          instructions: "Return an object",
          output_schema: {
            type: "object",
            properties: { answer: { type: "not-a-json-schema-type" } },
          },
        },
      }),
    ).rejects.toThrow("invalid output_schema");
  });
});
