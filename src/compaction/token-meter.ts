import type { AgentInputItem, ModelRequest } from "@openai/agents";

export const estimateTokens = (value: string): number =>
  Math.max(1, Math.ceil(Buffer.byteLength(value, "utf8") / 3));

export const inputText = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value ?? "");

export const estimateItemsTokens = (items: unknown[]): number =>
  estimateTokens(JSON.stringify(items));

export const estimateContextTokens = (
  items: unknown[],
  currentInput?: unknown,
  overheadTokens = 0,
): number =>
  estimateItemsTokens(items) +
  (currentInput === undefined ? 0 : estimateTokens(inputText(currentInput))) +
  Math.max(0, overheadTokens);

export interface RequestTokenEstimate {
  input_tokens: number;
  instructions_tokens: number;
  tools_tokens: number;
  handoffs_tokens: number;
  output_schema_tokens: number;
  total_tokens: number;
}

export function estimateModelRequest(
  request: ModelRequest,
): RequestTokenEstimate {
  const input = Array.isArray(request.input)
    ? estimateItemsTokens(request.input)
    : estimateTokens(request.input);
  const instructions = request.systemInstructions
    ? estimateTokens(request.systemInstructions)
    : 0;
  const tools = request.tools.length
    ? estimateTokens(JSON.stringify(request.tools))
    : 0;
  const handoffs = request.handoffs.length
    ? estimateTokens(JSON.stringify(request.handoffs))
    : 0;
  const outputSchema = estimateTokens(JSON.stringify(request.outputType));
  return {
    input_tokens: input,
    instructions_tokens: instructions,
    tools_tokens: tools,
    handoffs_tokens: handoffs,
    output_schema_tokens: outputSchema,
    total_tokens: input + instructions + tools + handoffs + outputSchema,
  };
}

export function modelReservedOutputTokens(
  modelSettings: Record<string, unknown> | undefined,
  capabilityMax?: number,
): number {
  const configured = Number(
    modelSettings?.maxTokens ?? modelSettings?.max_tokens ?? 0,
  );
  if (Number.isFinite(configured) && configured > 0)
    return Math.floor(configured);
  if (Number.isFinite(capabilityMax) && Number(capabilityMax) > 0)
    return Math.min(Number(capabilityMax), 16_384);
  return 0;
}

export function providerInputTokens(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["input_tokens", "prompt_tokens", "inputTokens"]) {
    const parsed = Number(record[key]);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  const inputDetails = record.inputTokensDetails;
  if (inputDetails && typeof inputDetails === "object") {
    const parsed = Number(
      (inputDetails as Record<string, unknown>).total_tokens,
    );
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

export class CalibratedTokenMeter {
  private multiplier = 1;
  private fixedOverhead = 0;

  estimateItems(items: AgentInputItem[], observedRequestOverhead = 0): number {
    const raw = estimateItemsTokens(items);
    return Math.max(
      1,
      Math.ceil(
        raw * this.multiplier + this.fixedOverhead + observedRequestOverhead,
      ),
    );
  }

  observe(estimated: RequestTokenEstimate, actualInputTokens: number): void {
    if (!Number.isFinite(actualInputTokens) || actualInputTokens <= 0) return;
    const variable = Math.max(1, estimated.input_tokens);
    const knownFixed = Math.max(0, estimated.total_tokens - variable);
    const observedVariable = Math.max(1, actualInputTokens - knownFixed);
    const ratio = Math.min(3, Math.max(0.5, observedVariable / variable));
    this.multiplier = this.multiplier * 0.6 + ratio * 0.4;
    const overhead = Math.max(
      0,
      actualInputTokens - Math.ceil(variable * this.multiplier),
    );
    this.fixedOverhead = Math.ceil(this.fixedOverhead * 0.6 + overhead * 0.4);
  }
}
