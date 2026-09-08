import type {
  Model,
  ModelRequest,
  ModelResponse,
  ModelRetryAdvice,
  ModelRetryAdviceRequest,
  StreamEvent,
} from "@openai/agents";

type JsonRecord = Record<string, unknown>;

export type ChatReasoningReplayField = "reasoning" | "reasoning_content";

const record = (value: unknown): JsonRecord | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;

const textValue = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textValue).join("");
  const item = record(value);
  if (!item) return "";
  for (const key of ["text", "delta", "reasoning", "thinking", "content"]) {
    const text = textValue(item[key]);
    if (text) return text;
  }
  return "";
};

const reasoningFrom = (container: JsonRecord): string => {
  for (const key of [
    "reasoning",
    "reasoning_content",
    "reasoningContent",
    "reasoning_details",
    "reasoningDetails",
    "reasoning_steps",
    "reasoningSteps",
  ]) {
    const text = textValue(container[key]);
    if (text) return text;
  }
  return "";
};

const normalizeMistralContent = (delta: JsonRecord) => {
  if (!Array.isArray(delta.content)) return;
  const visible: string[] = [];
  const reasoning: string[] = [];
  for (const rawPart of delta.content) {
    const part = record(rawPart);
    if (!part) continue;
    const type = String(part.type ?? "").toLowerCase();
    const text = textValue(part);
    if (!text) continue;
    if (type.includes("think") || type.includes("reason")) reasoning.push(text);
    else visible.push(text);
  }
  delta.content = visible.join("") || undefined;
  if (!reasoningFrom(delta) && reasoning.length)
    delta.reasoning = reasoning.join("");
};

/**
 * Normalize the reasoning aliases used by OpenAI-compatible Providers before
 * the Agents SDK resumes consuming the same streamed chunk. This lets its
 * built-in converter preserve a reasoning item for tool-call continuity while
 * Omoikane's public event layer still strips the private text.
 */
export function normalizeReasoningChunkInPlace(value: unknown): void {
  const envelope = record(value);
  if (envelope?.type !== "model") return;
  const chunk = record(envelope.event);
  if (!chunk || !Array.isArray(chunk.choices)) return;
  for (const rawChoice of chunk.choices) {
    const choice = record(rawChoice);
    const delta = record(choice?.delta);
    if (!delta) continue;
    normalizeMistralContent(delta);
    if (typeof delta.reasoning === "string" && delta.reasoning) continue;
    const reasoning = reasoningFrom(delta);
    if (reasoning) delta.reasoning = reasoning;
  }
}

const responseReasoning = (response: ModelResponse): string => {
  const providerData = record(response.providerData);
  const choice = Array.isArray(providerData?.choices)
    ? record(providerData.choices[0])
    : undefined;
  const message = record(choice?.message);
  return message ? reasoningFrom(message) : "";
};

/**
 * Rewrite only assistant-message reasoning aliases in an outgoing JSON Chat
 * Completions body. Several compatible Providers require reasoning_content on
 * tool-continuation turns while the Agents SDK emits reasoning.
 */
export function withChatReasoningReplayField(
  fetcher: typeof fetch,
  replayField: ChatReasoningReplayField,
): typeof fetch {
  if (replayField === "reasoning") return fetcher;
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.method !== "POST" || !request.url.includes("/chat/completions"))
      return fetcher(request);
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json"))
      return fetcher(request);
    let body: JsonRecord;
    try {
      body = JSON.parse(await request.clone().text()) as JsonRecord;
    } catch {
      return fetcher(request);
    }
    if (!Array.isArray(body.messages)) return fetcher(request);
    let changed = false;
    body.messages = body.messages.map((value) => {
      const message = record(value);
      if (
        !message ||
        message.role !== "assistant" ||
        typeof message.reasoning !== "string"
      )
        return value;
      const rewritten: JsonRecord = {
        ...message,
        [replayField]: message.reasoning,
      };
      delete rewritten.reasoning;
      changed = true;
      return rewritten;
    });
    return fetcher(
      changed ? new Request(request, { body: JSON.stringify(body) }) : request,
    );
  };
}

/** Add OpenAI-compatible reasoning aliases without replacing the SDK model. */
export class ReasoningCompatibleModel implements Model {
  constructor(private readonly inner: Model) {}

  getRetryAdvice(
    args: ModelRetryAdviceRequest,
  ): Promise<ModelRetryAdvice | undefined> | ModelRetryAdvice | undefined {
    return this.inner.getRetryAdvice?.(args);
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const response = await this.inner.getResponse(request);
    if (response.output.some((item) => item.type === "reasoning"))
      return response;
    const reasoning = responseReasoning(response);
    if (!reasoning) return response;
    return {
      ...response,
      output: [
        {
          type: "reasoning",
          content: [],
          rawContent: [{ type: "reasoning_text", text: reasoning }],
        },
        ...response.output,
      ],
    };
  }

  async *getStreamedResponse(
    request: ModelRequest,
  ): AsyncIterable<StreamEvent> {
    for await (const event of this.inner.getStreamedResponse(request)) {
      normalizeReasoningChunkInPlace(event);
      yield event;
    }
  }
}
