import type { AgentInputItem } from "@openai/agents";
import { hashJson } from "../serialization.js";
import { estimateTokens } from "./token-meter.js";
import type {
  CompactionAnchor,
  CompactionChunk,
  CompactionUnit,
  PortableCheckpointV4,
  ToolLedgerEntry,
  VerbatimUserExcerpt,
} from "./types.js";

const CHECKPOINT_START = '<context_checkpoint version="4"';
const CHECKPOINT_END = "</context_checkpoint>";

export const asRecord = (
  value: unknown,
): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const normalizeWhitespace = (value: string): string =>
  value
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();

export function itemRole(item: unknown): string {
  return String(asRecord(item)?.role ?? "");
}

export function itemType(item: unknown): string {
  const record = asRecord(item);
  if (!record) return typeof item;
  if (typeof record.type === "string") return record.type;
  if (record.role) return "message";
  return "unknown";
}

export function flattenItemText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (Array.isArray(value))
    return value.map(flattenItemText).filter(Boolean).join("\n");
  const record = asRecord(value);
  if (!record) return String(value);
  for (const key of ["text", "input_text", "output_text"]) {
    if (typeof record[key] === "string") return String(record[key]);
  }
  if (record.content !== undefined) return flattenItemText(record.content);
  if (record.output !== undefined) return flattenItemText(record.output);
  return "";
}

export function itemContainsAnchor(
  item: AgentInputItem,
  anchor: CompactionAnchor,
): boolean {
  if (anchor.kind !== "call_id")
    return flattenItemText(item).includes(anchor.value);
  const record = asRecord(item) ?? {};
  return (
    callId(record) === anchor.value ||
    toolCallRecords(record).some((call) => call.id === anchor.value)
  );
}

function callId(item: Record<string, unknown>): string {
  return String(
    item.call_id ?? item.callId ?? item.tool_call_id ?? item.toolCallId ?? "",
  );
}

function toolCallRecords(item: Record<string, unknown>): Array<{
  id: string;
  name: string;
  arguments: string;
}> {
  const result: Array<{ id: string; name: string; arguments: string }> = [];
  if (item.type === "function_call") {
    result.push({
      id: callId(item) || String(item.id ?? ""),
      name: String(item.name ?? "unknown"),
      arguments:
        typeof item.arguments === "string"
          ? item.arguments
          : JSON.stringify(item.arguments ?? {}),
    });
  }
  if (Array.isArray(item.tool_calls)) {
    for (const value of item.tool_calls) {
      const tool = asRecord(value);
      if (!tool) continue;
      const fn = asRecord(tool.function);
      result.push({
        id: String(tool.id ?? tool.call_id ?? ""),
        name: String(fn?.name ?? tool.name ?? "unknown"),
        arguments:
          typeof fn?.arguments === "string"
            ? fn.arguments
            : JSON.stringify(fn?.arguments ?? tool.arguments ?? {}),
      });
    }
  }
  return result;
}

function isToolOutput(item: Record<string, unknown>): boolean {
  return (
    item.role === "tool" ||
    item.type === "function_call_output" ||
    item.type === "tool_result"
  );
}

function toolOutputText(item: Record<string, unknown>): string {
  return flattenItemText(item.output ?? item.content ?? "");
}

function replaceToolOutput(
  item: Record<string, unknown>,
  replacement: string,
): AgentInputItem {
  if (item.type === "function_call_output")
    return { ...item, output: replacement } as AgentInputItem;
  return { ...item, content: replacement } as AgentInputItem;
}

function concise(value: string, max = 320): string {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= max) return normalized;
  const head = Math.floor(max * 0.65);
  const tail = max - head - 19;
  return `${normalized.slice(0, head)} …[truncated]… ${normalized.slice(-tail)}`;
}

export interface ToolPruneResult {
  items: AgentInputItem[];
  pruned_count: number;
  reclaimed_tokens: number;
  committed: boolean;
}

export function pruneToolResults(
  input: AgentInputItem[],
  options: {
    keepRecentResults?: number;
    minResultChars?: number;
    minReclaimTokens?: number;
  } = {},
): ToolPruneResult {
  const keepRecent = Math.max(1, options.keepRecentResults ?? 6);
  const minChars = Math.max(200, options.minResultChars ?? 1_500);
  const minReclaim = Math.max(0, options.minReclaimTokens ?? 4_096);
  const items = structuredClone(input) as AgentInputItem[];
  const outputIndexes = items
    .map((item, index) => ({ item: asRecord(item), index }))
    .filter(
      (entry): entry is { item: Record<string, unknown>; index: number } =>
        Boolean(entry.item && isToolOutput(entry.item)),
    )
    .map((entry) => entry.index);
  const protectedIndexes = new Set(outputIndexes.slice(-keepRecent));
  const newestByHash = new Map<string, number>();
  let pruned = 0;
  let before = 0;
  let after = 0;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = asRecord(items[index]);
    if (!item || !isToolOutput(item)) continue;
    const text = toolOutputText(item);
    if (!text || text.length < minChars) continue;
    before += estimateTokens(text);
    const digest = hashJson(text);
    const duplicate = newestByHash.has(digest);
    newestByHash.set(digest, index);
    if (protectedIndexes.has(index) && !duplicate) {
      after += estimateTokens(text);
      continue;
    }
    const call = callId(item);
    const replacement = duplicate
      ? `[tool_result_pruned duplicate=true call_id=${call || "unknown"} original_chars=${text.length} sha256=${digest}]`
      : `[tool_result_pruned call_id=${call || "unknown"} original_chars=${text.length} sha256=${digest} digest=${JSON.stringify(concise(text))}]`;
    items[index] = replaceToolOutput(item, replacement);
    after += estimateTokens(replacement);
    pruned += 1;
  }
  const reclaimed = Math.max(0, before - after);
  if (!pruned || reclaimed < minReclaim)
    return {
      items: input,
      pruned_count: 0,
      reclaimed_tokens: 0,
      committed: false,
    };
  return {
    items,
    pruned_count: pruned,
    reclaimed_tokens: reclaimed,
    committed: true,
  };
}

export function parsePortableCheckpointItem(
  item: unknown,
): PortableCheckpointV4 | undefined {
  const text = flattenItemText(item);
  const start = text.indexOf(CHECKPOINT_START);
  const end = text.indexOf(CHECKPOINT_END, start + CHECKPOINT_START.length);
  if (start < 0 || end < 0) return undefined;
  const bodyStart = text.indexOf(">", start);
  if (bodyStart < 0 || bodyStart >= end) return undefined;
  try {
    const value = JSON.parse(text.slice(bodyStart + 1, end).trim()) as unknown;
    const record = asRecord(value);
    if (
      record?.kind !== "omoikane_context_checkpoint" ||
      record.schema_version !== 4
    )
      return undefined;
    return value as PortableCheckpointV4;
  } catch {
    return undefined;
  }
}

export function renderPortableCheckpointItem(
  checkpoint: PortableCheckpointV4,
): AgentInputItem {
  const text = `${CHECKPOINT_START} reference_only="true">\n${JSON.stringify(checkpoint)}\n${CHECKPOINT_END}\n<end_context_checkpoint />`;
  return {
    role: "user",
    content: [{ type: "input_text", text }],
  } as AgentInputItem;
}

export function checkpointEvidenceSourceRefs(
  checkpoint: PortableCheckpointV4,
): number[] {
  const semanticRefs = Object.values(checkpoint.semantic)
    .filter(Array.isArray)
    .flatMap((facts) =>
      (facts as Array<{ source_refs?: number[] }>).flatMap(
        (fact) => fact.source_refs ?? [],
      ),
    );
  return [
    ...new Set([
      ...semanticRefs,
      ...checkpoint.anchors.flatMap((anchor) => anchor.source_refs),
      ...checkpoint.user_excerpts.map((excerpt) => excerpt.source_ref),
      ...checkpoint.tool_ledger.flatMap((entry) => entry.source_refs),
    ]),
  ].sort((a, b) => a - b);
}

function serializeStructuredItem(item: AgentInputItem, index: number): string {
  const record = asRecord(item) ?? {};
  const checkpoint = parsePortableCheckpointItem(item);
  if (checkpoint)
    return `[source_ref=${index} type=previous_checkpoint]\n${JSON.stringify(checkpoint)}`;
  const type = itemType(record);
  const role = itemRole(record);
  const header = `[source_ref=${index} type=${type}${role ? ` role=${role}` : ""}]`;
  if (type === "function_call") {
    return `${header}\ncall_id=${callId(record)} name=${String(record.name ?? "unknown")} arguments=${typeof record.arguments === "string" ? record.arguments : JSON.stringify(record.arguments ?? {})}`;
  }
  if (isToolOutput(record)) {
    return `${header}\ncall_id=${callId(record)} output=${toolOutputText(record)}`;
  }
  const calls = toolCallRecords(record);
  const text = flattenItemText(record);
  const details = calls.length ? `\ntool_calls=${JSON.stringify(calls)}` : "";
  if (text) return `${header}\ncontent=${text}${details}`;
  return `${header}\njson=${JSON.stringify(record)}`;
}

export function serializeItems(items: AgentInputItem[], fromIndex = 0): string {
  return items
    .map((item, index) => serializeStructuredItem(item, fromIndex + index))
    .join("\n\n");
}

export interface UnitPlan {
  units: CompactionUnit[];
  orphan_tool_results: number[];
}

export function planCompactionUnits(items: AgentInputItem[]): UnitPlan {
  const units: CompactionUnit[] = [];
  const orphans: number[] = [];
  let index = 0;
  while (index < items.length) {
    const item = asRecord(items[index]) ?? {};
    const checkpoint = parsePortableCheckpointItem(item);
    if (checkpoint) {
      units.push({
        id: `unit-${index}`,
        kind: "previous_checkpoint",
        from_index: index,
        to_index: index,
        items: [items[index]!],
        estimated_tokens: estimateTokens(JSON.stringify(items[index])),
        unresolved_tool_call: false,
      });
      index += 1;
      continue;
    }
    const calls = toolCallRecords(item);
    if (calls.length) {
      const expected = new Set(calls.map((value) => value.id).filter(Boolean));
      const found = new Set<string>();
      let end = index;
      while (end + 1 < items.length) {
        const next = asRecord(items[end + 1]) ?? {};
        if (!isToolOutput(next)) break;
        const id = callId(next);
        if (id) found.add(id);
        end += 1;
      }
      const unresolved = [...expected].some((id) => !found.has(id));
      const slice = items.slice(index, end + 1);
      units.push({
        id: `unit-${index}-${end}`,
        kind: "tool_transaction",
        from_index: index,
        to_index: end,
        items: slice,
        estimated_tokens: estimateTokens(JSON.stringify(slice)),
        unresolved_tool_call: unresolved,
      });
      index = end + 1;
      continue;
    }
    if (isToolOutput(item)) orphans.push(index);
    const role = itemRole(item);
    units.push({
      id: `unit-${index}`,
      kind:
        role === "user"
          ? "user_turn"
          : role === "assistant"
            ? "assistant_turn"
            : "provider_item",
      from_index: index,
      to_index: index,
      items: [items[index]!],
      estimated_tokens: estimateTokens(JSON.stringify(items[index])),
      unresolved_tool_call: false,
    });
    index += 1;
  }
  return { units, orphan_tool_results: orphans };
}

export function validateToolIntegrity(items: AgentInputItem[]): {
  valid: boolean;
  orphan_results: string[];
  unresolved_calls: string[];
} {
  const calls = new Set<string>();
  const outputs = new Set<string>();
  for (const item of items) {
    const record = asRecord(item) ?? {};
    for (const call of toolCallRecords(record)) if (call.id) calls.add(call.id);
    if (isToolOutput(record)) {
      const id = callId(record);
      if (id) outputs.add(id);
    }
  }
  const orphanResults = [...outputs].filter((id) => !calls.has(id));
  const unresolved = [...calls].filter((id) => !outputs.has(id));
  return {
    valid: orphanResults.length === 0 && unresolved.length === 0,
    orphan_results: orphanResults,
    unresolved_calls: unresolved,
  };
}

const anchorPatterns: Array<{
  kind: CompactionAnchor["kind"];
  pattern: RegExp;
}> = [
  {
    kind: "uuid",
    pattern:
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
  },
  { kind: "commit", pattern: /\b[0-9a-f]{9,40}\b/gi },
  { kind: "issue", pattern: /#\d{2,7}\b/g },
  {
    kind: "file",
    pattern:
      /(?:^|[\s'"`(])((?:\.{0,2}\/|\/)?[\w.@+-]+(?:\/[\w.@+-]+)+\.[A-Za-z0-9]{1,12})(?=$|[\s'"`),:])/gm,
  },
  { kind: "url", pattern: /https?:\/\/[^\s)"'<>]{8,240}/g },
  { kind: "version", pattern: /\bv?\d+\.\d+(?:\.\d+){0,2}(?:[-+][\w.-]+)?\b/g },
  {
    kind: "error",
    pattern:
      /\b(?:[A-Z][A-Za-z]*Error|Exception|Traceback|E[A-Z]{3,}|SIG[A-Z]+)\b[^\n]{0,120}/g,
  },
];

export function extractAnchors(
  items: AgentInputItem[],
  fromIndex = 0,
  tokenBudget = 2_000,
): CompactionAnchor[] {
  const found = new Map<string, CompactionAnchor>();
  for (const [offset, item] of items.entries()) {
    const source = fromIndex + offset;
    const text = flattenItemText(item);
    for (const { kind, pattern } of anchorPatterns) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        const raw = (match[1] ?? match[0]).trim().replace(/[.,;:]$/, "");
        if (!raw) continue;
        const key = `${kind}:${raw}`;
        const existing = found.get(key);
        if (existing) {
          if (!existing.source_refs.includes(source))
            existing.source_refs.push(source);
        } else found.set(key, { kind, value: raw, source_refs: [source] });
      }
    }
    const record = asRecord(item) ?? {};
    for (const call of toolCallRecords(record)) {
      if (!call.id) continue;
      const key = `call_id:${call.id}`;
      const existing = found.get(key);
      if (existing) existing.source_refs.push(source);
      else
        found.set(key, {
          kind: "call_id",
          value: call.id,
          source_refs: [source],
        });
    }
  }
  const result: CompactionAnchor[] = [];
  let used = 0;
  for (const anchor of found.values()) {
    const cost = estimateTokens(JSON.stringify(anchor));
    if (used + cost > tokenBudget) break;
    result.push(anchor);
    used += cost;
  }
  return result;
}

export function extractUserExcerpts(
  items: AgentInputItem[],
  fromIndex = 0,
  tokenBudget = 6_000,
  perItemBudget = 1_000,
): VerbatimUserExcerpt[] {
  const result: VerbatimUserExcerpt[] = [];
  let used = 0;
  for (let offset = items.length - 1; offset >= 0; offset -= 1) {
    const item = asRecord(items[offset]);
    if (!item || item.role !== "user" || parsePortableCheckpointItem(item))
      continue;
    const original = flattenItemText(item).trim();
    if (!original) continue;
    const remaining = tokenBudget - used;
    if (remaining <= 0) break;
    const allowed = Math.max(1, Math.min(perItemBudget, remaining));
    let text = original;
    let truncated = false;
    if (estimateTokens(text) > allowed) {
      const maxBytes = allowed * 3;
      text = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
      text = `${text} …[truncated]`;
      truncated = true;
    }
    result.push({
      source_ref: fromIndex + offset,
      text,
      truncated,
      sha256: hashJson(original),
    });
    used += estimateTokens(text);
  }
  return result;
}

export function buildToolLedger(
  items: AgentInputItem[],
  fromIndex = 0,
): ToolLedgerEntry[] {
  const entries = new Map<string, ToolLedgerEntry>();
  for (const [offset, item] of items.entries()) {
    const source = fromIndex + offset;
    const record = asRecord(item) ?? {};
    for (const call of toolCallRecords(record)) {
      const id = call.id || `anonymous-${source}-${call.name}`;
      entries.set(id, {
        call_id: id,
        tool_name: call.name,
        arguments_digest: concise(call.arguments),
        arguments_sha256: hashJson(call.arguments),
        status: "pending",
        source_refs: [source],
      });
    }
    if (!isToolOutput(record)) continue;
    const id = callId(record) || `orphan-${source}`;
    const output = toolOutputText(record);
    const entry = entries.get(id) ?? {
      call_id: id,
      tool_name: String(record.name ?? record.tool_name ?? "unknown"),
      status: "unknown" as const,
      source_refs: [],
    };
    entry.result_digest = concise(output);
    entry.result_sha256 = hashJson(output);
    entry.status = /\b(error|failed|exception|traceback|timeout)\b/i.test(
      output,
    )
      ? "failed"
      : "completed";
    if (!entry.source_refs.includes(source)) entry.source_refs.push(source);
    entries.set(id, entry);
  }
  return [...entries.values()];
}

export function buildChunks(
  units: CompactionUnit[],
  tokenLimit: number,
): CompactionChunk[] {
  const chunks: CompactionChunk[] = [];
  let texts: string[] = [];
  let unitIds: string[] = [];
  let refs: number[] = [];
  const flush = () => {
    if (!texts.length) return;
    const text = texts.join("\n\n");
    chunks.push({
      id: `chunk-${chunks.length + 1}`,
      unit_ids: [...unitIds],
      source_refs: [...new Set(refs)].sort((a, b) => a - b),
      checksum: hashJson(text),
      text,
    });
    texts = [];
    unitIds = [];
    refs = [];
  };
  for (const unit of units) {
    const serialized = serializeItems(unit.items, unit.from_index);
    const parts: string[] = [];
    if (estimateTokens(serialized) <= tokenLimit) parts.push(serialized);
    else {
      const maxBytes = tokenLimit * 3;
      const buffer = Buffer.from(serialized, "utf8");
      for (let start = 0; start < buffer.length; start += maxBytes) {
        parts.push(
          `[unit_id=${unit.id} segment=${Math.floor(start / maxBytes) + 1}]\n${buffer.subarray(start, Math.min(buffer.length, start + maxBytes)).toString("utf8")}`,
        );
      }
    }
    for (const part of parts) {
      const candidate = [...texts, part].join("\n\n");
      if (texts.length && estimateTokens(candidate) > tokenLimit) flush();
      texts.push(part);
      if (!unitIds.includes(unit.id)) unitIds.push(unit.id);
      for (let ref = unit.from_index; ref <= unit.to_index; ref += 1)
        refs.push(ref);
      if (unit.kind === "previous_checkpoint") {
        const checkpoint = parsePortableCheckpointItem(unit.items[0]);
        if (checkpoint) refs.push(...checkpointEvidenceSourceRefs(checkpoint));
      }
      if (estimateTokens(texts.join("\n\n")) >= tokenLimit) flush();
    }
  }
  flush();
  return chunks;
}
