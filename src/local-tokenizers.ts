import { Template } from "@huggingface/jinja";
import { Tokenizer } from "@huggingface/tokenizers";
import type { ModelRequest } from "@openai/agents";

export interface OfficialTokenizerDescriptor {
  tokenizer_id: string;
  tokenizer_revision: string;
}

interface LoadedTokenizer {
  tokenizer: Tokenizer;
  config: Record<string, unknown>;
}

type JsonRecord = Record<string, unknown>;

const TOKENIZER_DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_TOKENIZER_FILE_BYTES = 64 * 1024 * 1024;
const tokenizerCache = new Map<string, Promise<LoadedTokenizer>>();

const asRecord = (value: unknown): JsonRecord | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;

const tokenContent = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  return typeof asRecord(value)?.content === "string"
    ? String(asRecord(value)!.content)
    : undefined;
};

const pythonJson = (value: unknown): string => {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(", ")}]`;
  const record = asRecord(value);
  if (record)
    return `{${Object.entries(record)
      .map(([key, item]) => `${JSON.stringify(key)}: ${pythonJson(item)}`)
      .join(", ")}}`;
  throw new Error("DeepSeek Prompt Encoder received a non-JSON value");
};

async function fetchTokenizerJson(url: string): Promise<JsonRecord> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TOKENIZER_DOWNLOAD_TIMEOUT_MS),
    });
  } catch {
    throw new Error(`could not download official Tokenizer asset: ${url}`);
  }
  if (!response.ok)
    throw new Error(
      `official Tokenizer asset returned HTTP ${response.status}: ${url}`,
    );
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_TOKENIZER_FILE_BYTES
  )
    throw new Error(`official Tokenizer asset exceeds the size limit: ${url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_TOKENIZER_FILE_BYTES)
    throw new Error(`official Tokenizer asset exceeds the size limit: ${url}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error(`official Tokenizer asset is not valid JSON: ${url}`);
  }
  const record = asRecord(parsed);
  if (!record)
    throw new Error(`official Tokenizer asset is not a JSON object: ${url}`);
  return record;
}

async function loadTokenizer(
  descriptor: OfficialTokenizerDescriptor,
): Promise<LoadedTokenizer> {
  const cacheKey = `${descriptor.tokenizer_id}@${descriptor.tokenizer_revision}`;
  let loading = tokenizerCache.get(cacheKey);
  if (!loading) {
    loading = (async () => {
      const base = `https://huggingface.co/${descriptor.tokenizer_id}/resolve/${descriptor.tokenizer_revision}`;
      const [tokenizerJson, config] = await Promise.all([
        fetchTokenizerJson(`${base}/tokenizer.json`),
        fetchTokenizerJson(`${base}/tokenizer_config.json`),
      ]);
      return {
        tokenizer: new Tokenizer(tokenizerJson, config),
        config,
      };
    })();
    tokenizerCache.set(cacheKey, loading);
    loading.catch(() => tokenizerCache.delete(cacheKey));
  }
  return loading;
}

function selectedChatTemplate(config: JsonRecord): string {
  if (typeof config.chat_template === "string") return config.chat_template;
  if (Array.isArray(config.chat_template)) {
    const candidates = config.chat_template.map(asRecord).filter(Boolean);
    const selected =
      candidates.find((item) => item!.name === "default") ?? candidates[0];
    if (typeof selected?.template === "string") return selected.template;
  }
  throw new Error("official Tokenizer does not publish a usable chat_template");
}

function textContent(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (!Array.isArray(value))
    throw new Error("local Tokenizer supports text message content only");
  return value
    .map((part) => {
      const block = asRecord(part);
      if (!block || block.type !== "text" || typeof block.text !== "string")
        throw new Error(
          "local Tokenizer supports text input only; use a Provider count endpoint for multimodal input",
        );
      return block.text;
    })
    .join("");
}

function normalizedTextMessages(value: unknown): JsonRecord[] {
  if (!Array.isArray(value))
    throw new Error("compiled Provider request does not contain messages");
  return value.map((item) => {
    const message = asRecord(item);
    if (!message || typeof message.role !== "string")
      throw new Error("compiled Provider request contains an invalid message");
    return { ...message, content: textContent(message.content) };
  });
}

function templateVariables(
  config: JsonRecord,
  messages: JsonRecord[],
  tools: unknown,
  body: JsonRecord,
): JsonRecord {
  const reasoningEffort = body.reasoning_effort;
  const variables: JsonRecord = {
    messages,
    tools: Array.isArray(tools) ? tools : [],
    add_generation_prompt: true,
  };
  for (const key of ["bos_token", "eos_token", "unk_token", "pad_token"])
    variables[key] = tokenContent(config[key]) ?? "";
  if (reasoningEffort !== undefined)
    variables.enable_thinking = reasoningEffort !== "none";
  return variables;
}

function renderChatTemplate(config: JsonRecord, body: JsonRecord): string {
  const messages = normalizedTextMessages(body.messages);
  return new Template(selectedChatTemplate(config)).render(
    templateVariables(config, messages, body.tools, body),
  );
}

const BOS = "<｜begin▁of▁sentence｜>";
const EOS = "<｜end▁of▁sentence｜>";
const THINK_START = "<think>";
const THINK_END = "</think>";
const DSML = "｜DSML｜";
const USER = "<｜User｜>";
const ASSISTANT = "<｜Assistant｜>";

const DEEPSEEK_REASONING_MAX =
  "Reasoning Effort: Absolute maximum with no shortcuts permitted.\n" +
  "You MUST be very thorough in your thinking and comprehensively decompose the problem to resolve the root cause, rigorously stress-testing your logic against all potential paths, edge cases, and adversarial scenarios.\n" +
  "Explicitly write out your entire deliberation process, documenting every intermediate step, considered alternative, and rejected hypothesis to ensure absolutely no assumption is left unchecked.\n\n";

const deepseekTools = (tools: JsonRecord[]): string => {
  const schemas = tools.map((tool) => pythonJson(tool)).join("\n");
  return `## Tools

You have access to a set of tools to help answer the user's question. You can invoke tools by writing a "<${DSML}tool_calls>" block like the following:

<${DSML}tool_calls>
<${DSML}invoke name="$TOOL_NAME">
<${DSML}parameter name="$PARAMETER_NAME" string="true|false">$PARAMETER_VALUE</${DSML}parameter>
...
</${DSML}invoke>
<${DSML}invoke name="$TOOL_NAME2">
...
</${DSML}invoke>
</${DSML}tool_calls>

String parameters should be specified as is and set \`string="true"\`. For all other types (numbers, booleans, arrays, objects), pass the value in JSON format and set \`string="false"\`.

If thinking_mode is enabled (triggered by ${THINK_START}), you MUST output your complete reasoning inside ${THINK_START}...${THINK_END} BEFORE any tool calls or final response.

Otherwise, output directly after ${THINK_END} with tool calls or final response.

### Available Tool Schemas

${schemas}

You MUST strictly follow the above defined tool name and parameter schemas to invoke tool calls.
`;
};

function deepseekArguments(toolCall: JsonRecord): string {
  const fn = asRecord(toolCall.function) ?? toolCall;
  const raw = typeof fn.arguments === "string" ? fn.arguments : "{}";
  let argumentsValue: JsonRecord;
  try {
    argumentsValue = asRecord(JSON.parse(raw)) ?? { arguments: raw };
  } catch {
    argumentsValue = { arguments: raw };
  }
  return Object.entries(argumentsValue)
    .map(
      ([key, value]) =>
        `<${DSML}parameter name="${key}" string="${typeof value === "string"}">${typeof value === "string" ? value : pythonJson(value)}</${DSML}parameter>`,
    )
    .join("\n");
}

function mergeDeepseekToolMessages(messages: JsonRecord[]): JsonRecord[] {
  const merged: JsonRecord[] = [];
  for (const original of messages) {
    const message = structuredClone(original);
    if (message.role === "tool") {
      const block = {
        type: "tool_result",
        tool_use_id: message.tool_call_id ?? "",
        content: textContent(message.content),
      };
      const previous = merged.at(-1);
      if (previous?.role === "user" && Array.isArray(previous.content_blocks))
        previous.content_blocks.push(block);
      else merged.push({ role: "user", content_blocks: [block] });
    } else if (message.role === "user") {
      const block = { type: "text", text: textContent(message.content) };
      const previous = merged.at(-1);
      if (
        previous?.role === "user" &&
        Array.isArray(previous.content_blocks) &&
        previous.task === undefined
      )
        previous.content_blocks.push(block);
      else
        merged.push({
          ...message,
          content: block.text,
          content_blocks: [block],
        });
    } else merged.push(message);
  }
  return merged;
}

function sortDeepseekToolResults(messages: JsonRecord[]): JsonRecord[] {
  let order = new Map<string, number>();
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      order = new Map(
        message.tool_calls.map((value, index) => {
          const call = asRecord(value) ?? {};
          const fn = asRecord(call.function);
          return [String(call.id ?? fn?.id ?? ""), index];
        }),
      );
    } else if (
      message.role === "user" &&
      Array.isArray(message.content_blocks) &&
      order.size
    ) {
      const results = message.content_blocks
        .map(asRecord)
        .filter((block) => block?.type === "tool_result")
        .sort(
          (a, b) =>
            (order.get(String(a!.tool_use_id ?? "")) ?? 0) -
            (order.get(String(b!.tool_use_id ?? "")) ?? 0),
        );
      let index = 0;
      message.content_blocks = message.content_blocks.map((block) =>
        asRecord(block)?.type === "tool_result" ? results[index++]! : block,
      );
    }
  }
  return messages;
}

const lastDeepseekUser = (messages: JsonRecord[]) => {
  for (let index = messages.length - 1; index >= 0; index--)
    if (["user", "developer"].includes(String(messages[index]!.role)))
      return index;
  return -1;
};

function droppedDeepseekThinking(messages: JsonRecord[]): JsonRecord[] {
  const lastUser = lastDeepseekUser(messages);
  const keepRoles = new Set([
    "user",
    "system",
    "tool",
    "latest_reminder",
    "direct_search_results",
  ]);
  return messages.flatMap((message, index) => {
    if (keepRoles.has(String(message.role)) || index >= lastUser)
      return [message];
    if (message.role === "assistant") {
      const copy = { ...message };
      delete copy.reasoning_content;
      return [copy];
    }
    return [];
  });
}

function deepseekContentBlocks(message: JsonRecord): string {
  if (!Array.isArray(message.content_blocks))
    return textContent(message.content);
  return message.content_blocks
    .map((value) => {
      const block = asRecord(value);
      if (block?.type === "text") return String(block.text ?? "");
      if (block?.type === "tool_result")
        return `<tool_result>${textContent(block.content)}</tool_result>`;
      throw new Error(
        "DeepSeek local Tokenizer supports text and tool-result blocks only",
      );
    })
    .join("\n\n");
}

function renderDeepseekMessage(
  index: number,
  messages: JsonRecord[],
  thinking: boolean,
  dropThinking: boolean,
  reasoningEffort: string | undefined,
): string {
  const message = messages[index]!;
  const role = String(message.role);
  const lastUser = lastDeepseekUser(messages);
  let prompt =
    index === 0 && thinking && reasoningEffort === "max"
      ? DEEPSEEK_REASONING_MAX
      : "";
  const tools = Array.isArray(message.tools)
    ? (message.tools
        .map(asRecord)
        .filter(Boolean)
        .map((tool) => asRecord(tool!.function) ?? tool!) as JsonRecord[])
    : [];
  const responseFormat = message.response_format;
  const additions = [
    tools.length ? deepseekTools(tools) : "",
    responseFormat
      ? `## Response Format:\n\nYou MUST strictly adhere to the following schema to reply:\n${pythonJson(responseFormat)}`
      : "",
  ].filter(Boolean);

  if (role === "system")
    prompt += [textContent(message.content), ...additions].join("\n\n");
  else if (role === "developer")
    prompt += USER + [textContent(message.content), ...additions].join("\n\n");
  else if (role === "user") prompt += USER + deepseekContentBlocks(message);
  else if (role === "latest_reminder")
    prompt += `<｜latest_reminder｜>${textContent(message.content)}`;
  else if (role === "assistant") {
    const previousHasTask = messages[index - 1]?.task !== undefined;
    const reasoning =
      thinking && !previousHasTask && (!dropThinking || index > lastUser)
        ? String(message.reasoning_content ?? "") + THINK_END
        : "";
    let toolCalls = "";
    if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
      const rendered = message.tool_calls
        .map(asRecord)
        .filter(Boolean)
        .map((call) => {
          const fn = asRecord(call!.function) ?? call!;
          return `<${DSML}invoke name="${String(fn.name ?? "")}">\n${deepseekArguments(call!)}\n</${DSML}invoke>`;
        })
        .join("\n");
      toolCalls = `\n\n<${DSML}tool_calls>\n${rendered}\n</${DSML}tool_calls>`;
    }
    prompt +=
      reasoning +
      textContent(message.content) +
      toolCalls +
      (message.wo_eos ? "" : EOS);
  } else throw new Error(`DeepSeek local Tokenizer cannot encode role ${role}`);

  if (
    index + 1 < messages.length &&
    !["assistant", "latest_reminder"].includes(
      String(messages[index + 1]!.role),
    )
  )
    return prompt;
  if (["user", "developer"].includes(role))
    prompt +=
      ASSISTANT +
      (thinking && (!dropThinking || index >= lastUser)
        ? THINK_START
        : THINK_END);
  return prompt;
}

export function renderDeepseekV4Prompt(body: JsonRecord): string {
  let messages = normalizedTextMessages(body.messages);
  const tools = Array.isArray(body.tools)
    ? body.tools
        .map(asRecord)
        .filter(Boolean)
        .map((tool) => asRecord(tool!.function) ?? tool!)
    : [];
  const wireResponseFormat = asRecord(body.response_format);
  const responseFormat =
    asRecord(wireResponseFormat?.json_schema)?.schema ?? wireResponseFormat;
  if (tools.length || responseFormat) {
    if (!["system", "developer"].includes(String(messages[0]?.role)))
      messages.unshift({ role: "system", content: "" });
    messages[0] = {
      ...messages[0],
      ...(tools.length ? { tools } : {}),
      ...(responseFormat ? { response_format: responseFormat } : {}),
    };
  }
  messages = sortDeepseekToolResults(mergeDeepseekToolMessages(messages));
  let dropThinking = !messages.some(
    (message) => Array.isArray(message.tools) && message.tools.length,
  );
  const reasoningEffort =
    typeof body.reasoning_effort === "string"
      ? body.reasoning_effort
      : undefined;
  const thinking = reasoningEffort !== undefined && reasoningEffort !== "none";
  if (thinking && dropThinking) messages = droppedDeepseekThinking(messages);
  if (!thinking) dropThinking = true;
  return (
    BOS +
    messages
      .map((_, index) =>
        renderDeepseekMessage(
          index,
          messages,
          thinking,
          dropThinking,
          reasoningEffort,
        ),
      )
      .join("")
  );
}

export async function countWithOfficialTokenizer(
  body: JsonRecord,
  descriptor: OfficialTokenizerDescriptor,
): Promise<number> {
  const loaded = await loadTokenizer(descriptor);
  const prompt = descriptor.tokenizer_id.startsWith("deepseek-ai/DeepSeek-V4-")
    ? renderDeepseekV4Prompt(body)
    : renderChatTemplate(loaded.config, body);
  return loaded.tokenizer.encode(prompt, { add_special_tokens: false }).ids
    .length;
}

export function localTokenizerRequestHasMultimodalInput(
  request: ModelRequest,
): boolean {
  if (typeof request.input === "string") return false;
  return request.input.some((item) => {
    const record = asRecord(item);
    const content = record?.content;
    return (
      Array.isArray(content) &&
      content.some((part) => {
        const block = asRecord(part);
        return (
          block &&
          !["input_text", "output_text", "text"].includes(String(block.type))
        );
      })
    );
  });
}

export function clearOfficialTokenizerCacheForTests() {
  tokenizerCache.clear();
}
