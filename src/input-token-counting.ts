import {
  Runner,
  type AgentInputItem,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type ResponseStreamEvent,
} from "@openai/agents";
import type { Database } from "./database.js";
import type { AgentFactory } from "./agent-factory.js";
import type { CompactionService } from "./compaction.js";
import type { ProviderService } from "./providers.js";
import type { RuntimeContext } from "./tools.js";
import { ResourceStore } from "./resources.js";
import { newId } from "./serialization.js";

export interface InputTokenCountInput {
  input: string | AgentInputItem[];
  conversation?: AgentInputItem[];
  projection?: Record<string, unknown>;
  context?: Record<string, unknown>;
}

export class InputTokenCountingError extends Error {
  readonly statusCode = 422;
  constructor(
    message: string,
    readonly errorCode:
      | "input_token_counting_not_supported"
      | "input_token_counting_not_qualified"
      | "input_token_counting_request_invalid",
  ) {
    super(message);
    this.name = "InputTokenCountingError";
  }
}

class AssembledInputCaptureModel implements Model {
  request?: ModelRequest;

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.request = request;
    throw new Error("OMOIKANE_ASSEMBLED_INPUT_CAPTURED");
  }

  async *getStreamedResponse(
    request: ModelRequest,
  ): AsyncIterable<ResponseStreamEvent> {
    this.request = request;
    throw new Error("OMOIKANE_ASSEMBLED_INPUT_CAPTURED");
  }
}

export function assembleRunInput(
  input: string | AgentInputItem[],
  conversation: AgentInputItem[],
): string | AgentInputItem[] {
  if (!conversation.length) return input;
  const current =
    typeof input === "string"
      ? ([{ role: "user", content: input }] as AgentInputItem[])
      : input;
  return [...conversation, ...current];
}

export class InputTokenCountingService {
  private readonly store: ResourceStore;

  constructor(
    db: Database,
    private readonly factory: AgentFactory,
    private readonly providers: ProviderService,
    private readonly compaction: CompactionService,
  ) {
    this.store = new ResourceStore(db);
  }

  async count(deploymentId: string, input: InputTokenCountInput) {
    const deployment = await this.store.get<Record<string, unknown>>(
      "agent_deployment",
      deploymentId,
    );
    if (deployment.status !== "active")
      throw new InputTokenCountingError(
        "input Token counting requires an active Agent deployment",
        "input_token_counting_request_invalid",
      );
    const config = await this.providers.resolveConfig({
      ...((deployment.config ?? {}) as Record<string, unknown>),
    });
    const capability = config._capabilities?.input_token_counting;
    if (!capability)
      throw new InputTokenCountingError(
        `model ${config.model} does not declare input Token counting`,
        "input_token_counting_not_supported",
      );
    if (capability.status !== "qualified")
      throw new InputTokenCountingError(
        `model ${config.model} does not have qualified input Token counting`,
        "input_token_counting_not_qualified",
      );

    let conversation = input.conversation ?? [];
    if (input.projection) {
      try {
        this.compaction.validateProjection(input.projection, config);
      } catch (error) {
        throw new InputTokenCountingError(
          error instanceof Error ? error.message : "Projection is invalid",
          "input_token_counting_request_invalid",
        );
      }
      if (!Array.isArray(input.projection.items))
        throw new InputTokenCountingError(
          "Projection does not contain model input items",
          "input_token_counting_request_invalid",
        );
      conversation = input.projection.items as AgentInputItem[];
    }
    const assembledInput = assembleRunInput(input.input, conversation);
    const syntheticRunId = `input-token-count-${newId()}`;
    const context: RuntimeContext = {
      ...(input.context ?? {}),
      run_id: syntheticRunId,
      deployment_id: deploymentId,
    };
    const capture = new AssembledInputCaptureModel();
    const built = await this.factory.build(deploymentId, context, new Set(), {
      modelDecorator: () => capture,
      persistMcpBindings: false,
      includeGuardrails: false,
    });
    try {
      try {
        await new Runner({ tracingDisabled: true }).run(
          built.agent,
          assembledInput,
          {
            context,
            maxTurns: 1,
          },
        );
      } catch {
        // The capture Model stops before any Provider generation request.
      }
      if (!capture.request)
        throw new InputTokenCountingError(
          "AgentSDK did not produce an assembled model input",
          "input_token_counting_request_invalid",
        );
      const counted = await this.providers.countModelInputTokens(
        config._connection,
        config.model,
        capture.request,
        capability,
      );
      const contextWindow = Number(
        config.model_context_window ?? config._capabilities?.context_window,
      );
      if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0)
        throw new InputTokenCountingError(
          `model ${config.model} does not have a valid context window`,
          "input_token_counting_request_invalid",
        );
      const settings = (config.model_settings ?? {}) as Record<string, unknown>;
      const contextWindowType = config._capabilities!.context_window_type;
      const reservedOutputTokens =
        contextWindowType === "input"
          ? 0
          : Number(
              settings.maxTokens ??
                config._capabilities?.max_output_tokens ??
                0,
            );
      const maximumInputTokens =
        contextWindowType === "input"
          ? Number(config._capabilities?.max_input_tokens ?? contextWindow)
          : contextWindow - reservedOutputTokens;
      if (!Number.isSafeInteger(maximumInputTokens) || maximumInputTokens <= 0)
        throw new InputTokenCountingError(
          "model output reservation leaves no available input Token budget",
          "input_token_counting_request_invalid",
        );
      return {
        deployment_id: deploymentId,
        provider: config.provider.name,
        model_id: config.model,
        input_tokens: counted.input_tokens,
        context_window_type: contextWindowType,
        context_window_tokens: contextWindow,
        reserved_output_tokens: reservedOutputTokens,
        maximum_input_tokens: maximumInputTokens,
        method: capability.method!,
        accuracy: capability.accuracy!,
        ...(capability.tokenizer_id
          ? { tokenizer_id: capability.tokenizer_id }
          : {}),
        ...(capability.tokenizer_revision
          ? { tokenizer_revision: capability.tokenizer_revision }
          : {}),
        counted_at: new Date().toISOString(),
      };
    } finally {
      await built.close();
    }
  }
}
