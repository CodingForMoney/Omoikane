import { afterEach, describe, expect, it } from "vitest";
import {
  ScriptedModel,
  assistantMessage,
  modelResponse,
} from "@openai/agents/testing";
import type { Container } from "../src/container.js";
import {
  registerGuardrailImplementation,
  unregisterGuardrailImplementation,
} from "../src/guardrails.js";
import { publishedAgent, testContainer } from "./helpers.js";

let container: Container | undefined;
let cleanup: (() => Promise<void>) | undefined;
const registered = new Set<string>();

const register = (
  key: string,
  implementation: Parameters<typeof registerGuardrailImplementation>[1],
) => {
  registerGuardrailImplementation(key, implementation);
  registered.add(key);
};

afterEach(async () => {
  for (const key of registered) unregisterGuardrailImplementation(key);
  registered.clear();
  await cleanup?.();
  container = undefined;
  cleanup = undefined;
});

describe("Guardrail runtime contract", () => {
  it("normalizes legacy regex policies and rejects invalid configuration at deployment", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;

    const deployed = await container.definitions.deploy({
      config: {
        name: "Legacy Guardrail",
        instructions: "Answer accurately.",
        guardrails: {
          input_deny_patterns: ["forbidden"],
          output_deny_patterns: ["blocked"],
        },
      },
    });
    expect(deployed.config.guardrails).toEqual({
      input: [
        {
          id: "legacy-input-regex",
          implementation_key: "builtin.regex",
          config: { deny_patterns: ["forbidden"] },
          timeout_ms: 1_000,
          on_error: "block",
        },
      ],
      output: [
        {
          id: "legacy-output-regex",
          implementation_key: "builtin.regex",
          config: { deny_patterns: ["blocked"] },
          timeout_ms: 1_000,
          on_error: "block",
        },
      ],
    });

    await expect(
      container.definitions.deploy({
        config: {
          name: "Invalid Guardrail",
          instructions: "Answer accurately.",
          guardrails: {
            input: [
              {
                id: "invalid-regex",
                implementation_key: "builtin.regex",
                config: { deny_patterns: ["["] },
              },
            ],
          },
        },
      }),
    ).rejects.toThrow("is not a valid regular expression");

    await expect(
      container.definitions.deploy({
        config: {
          name: "Missing implementation",
          instructions: "Answer accurately.",
          guardrails: {
            input: [
              {
                id: "missing",
                implementation_key: "business.not_registered",
              },
            ],
          },
        },
      }),
    ).rejects.toThrow("is not registered");
  });

  it("blocks input before a model call and emits no checked content", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    register("test.input-policy", ({ value }) =>
      String(value).includes("CLASSIFIED_INPUT")
        ? { decision: "block", code: "business_input_policy" }
        : { decision: "allow" },
    );
    const model = new ScriptedModel([
      modelResponse([assistantMessage("model must not run")]),
    ]);
    const fixture = await publishedAgent(container, {
      model,
      guardrails: {
        input: [
          {
            id: "business-input",
            implementation_key: "test.input-policy",
          },
        ],
      },
    });
    const created = await container.runner.create({
      deploymentId: fixture.version.id,
      input: "CLASSIFIED_INPUT",
    });

    await container.runner.processNext();

    const failed = await container.runner.get(created.id);
    expect(failed.status).toBe("failed");
    expect(failed.error_json).toMatchObject({
      code: "input_guardrail_blocked",
      details: {
        stage: "input",
        guardrail_id: "business-input",
        implementation_key: "test.input-policy",
        policy_code: "business_input_policy",
      },
    });
    expect(model.calls).toHaveLength(0);
    const events = await container.events.list(created.id);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "guardrail.started",
        "guardrail.blocked",
        "run.failed",
      ]),
    );
    expect(JSON.stringify(events)).not.toContain("CLASSIFIED_INPUT");
  });

  it("never publishes rejected output or reasoning through Run Events", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const rejected = "TOP_SECRET_OUTPUT";
    const model = new ScriptedModel([
      modelResponse([assistantMessage(rejected)]),
    ]);
    const fixture = await publishedAgent(container, {
      model,
      guardrails: {
        output: [
          {
            id: "output-policy",
            implementation_key: "builtin.regex",
            config: { deny_patterns: [rejected] },
          },
        ],
      },
    });
    const created = await container.runner.create({
      deploymentId: fixture.version.id,
      input: "Return the protected text",
    });

    await container.runner.processNext();

    const failed = await container.runner.get(created.id);
    expect(failed.status).toBe("failed");
    expect(failed.output_json).toBeNull();
    expect(failed.error_json).toMatchObject({
      code: "output_guardrail_blocked",
      details: {
        stage: "output",
        guardrail_id: "output-policy",
        policy_code: "regex_deny_match",
      },
    });
    const events = await container.events.list(created.id);
    expect(events.some((event) => event.type === "model.output_delta")).toBe(
      false,
    );
    expect(JSON.stringify(events)).not.toContain(rejected);
    const message = events.find(
      (event) => event.type === "message_output_created",
    );
    expect(message?.payload_json).toMatchObject({
      item_available: false,
      output_validation: "guardrail_buffered",
    });
  });

  it("publishes accepted output only after the output Guardrail passes", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    register("test.output-allow", () => ({ decision: "allow" }));
    const accepted = "accepted output";
    const model = new ScriptedModel([
      modelResponse([assistantMessage(accepted)]),
    ]);
    const fixture = await publishedAgent(container, {
      model,
      guardrails: {
        output: [
          {
            id: "allow-output",
            implementation_key: "test.output-allow",
          },
        ],
      },
    });
    const created = await container.runner.create({
      deploymentId: fixture.version.id,
      input: "Return an accepted answer",
    });

    await container.runner.processNext();

    const completed = await container.runner.publicRun(created.id);
    expect(completed.status).toBe("completed");
    expect(completed.output).toBe(accepted);
    const events = await container.events.list(created.id);
    const deltas = events.filter(
      (event) => event.type === "model.output_delta",
    );
    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.payload_json).toMatchObject({
      delta: accepted,
      source_type: "guardrail.accepted_output",
      provisional: false,
      buffered: true,
    });
    const passed = events.findIndex(
      (event) => event.type === "guardrail.passed",
    );
    const published = events.findIndex(
      (event) => event.type === "model.output_delta",
    );
    const terminal = events.findIndex(
      (event) => event.type === "run.completed",
    );
    expect(passed).toBeGreaterThanOrEqual(0);
    expect(published).toBeGreaterThan(passed);
    expect(terminal).toBeGreaterThan(published);
  });

  it("applies bounded timeout and explicit fail-open/fail-closed behavior", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    register(
      "test.timeout",
      ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => resolve({ decision: "allow" }),
            { once: true },
          );
        }),
    );
    const blockedModel = new ScriptedModel([
      modelResponse([assistantMessage("must not run")]),
    ]);
    const blockedFixture = await publishedAgent(container, {
      model: blockedModel,
      guardrails: {
        input: [
          {
            id: "timeout-block",
            implementation_key: "test.timeout",
            timeout_ms: 5,
          },
        ],
      },
    });
    const blockedRun = await container.runner.create({
      deploymentId: blockedFixture.version.id,
      input: "check",
    });
    await container.runner.processNext();
    expect(
      (await container.runner.get(blockedRun.id)).error_json,
    ).toMatchObject({ code: "guardrail_timeout" });
    expect(blockedModel.calls).toHaveLength(0);

    const allowedModel = new ScriptedModel([
      modelResponse([assistantMessage("allowed after timeout")]),
    ]);
    const allowedFixture = await publishedAgent(container, {
      model: allowedModel,
      guardrails: {
        input: [
          {
            id: "timeout-allow",
            implementation_key: "test.timeout",
            timeout_ms: 5,
            on_error: "allow",
          },
        ],
      },
    });
    const allowedRun = await container.runner.create({
      deploymentId: allowedFixture.version.id,
      input: "check",
    });
    await container.runner.processNext();
    expect((await container.runner.publicRun(allowedRun.id)).status).toBe(
      "completed",
    );
    expect(allowedModel.calls).toHaveLength(1);
    const failedEvent = (await container.events.list(allowedRun.id)).find(
      (event) => event.type === "guardrail.failed",
    );
    expect(failedEvent?.payload_json).toMatchObject({
      code: "guardrail_timeout",
      decision: "allow",
      on_error: "allow",
    });

    register("test.failure", () => {
      throw new Error("SENSITIVE_IMPLEMENTATION_DETAIL");
    });
    const failedModel = new ScriptedModel([
      modelResponse([assistantMessage("must not run")]),
    ]);
    const failedFixture = await publishedAgent(container, {
      model: failedModel,
      guardrails: {
        input: [
          {
            id: "execution-failure",
            implementation_key: "test.failure",
          },
        ],
      },
    });
    const executionFailure = await container.runner.create({
      deploymentId: failedFixture.version.id,
      input: "check",
    });
    await container.runner.processNext();
    expect(
      (await container.runner.get(executionFailure.id)).error_json,
    ).toMatchObject({ code: "guardrail_execution_failed" });
    expect(failedModel.calls).toHaveLength(0);
    expect(
      JSON.stringify(await container.events.list(executionFailure.id)),
    ).not.toContain("SENSITIVE_IMPLEMENTATION_DETAIL");
  });
});
