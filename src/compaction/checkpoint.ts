import { ValidationError } from "../database.js";
import type { SemanticCheckpoint, SourceFact } from "./types.js";

const factSchema = {
  type: "object",
  properties: {
    text: { type: "string" },
    source_refs: { type: "array", items: { type: "integer" } },
  },
  required: ["text", "source_refs"],
  additionalProperties: false,
} as const;

export const semanticCheckpointSchema = {
  type: "json_schema" as const,
  name: "omoikane_context_checkpoint",
  strict: true,
  schema: {
    type: "object" as const,
    properties: {
      active_task: { type: "string" },
      goal: { type: "string" },
      constraints: { type: "array", items: factSchema },
      decisions: { type: "array", items: factSchema },
      completed_actions: { type: "array", items: factSchema },
      current_state: { type: "array", items: factSchema },
      open_questions: { type: "array", items: factSchema },
      errors: { type: "array", items: factSchema },
      artifacts: { type: "array", items: factSchema },
      critical_facts: { type: "array", items: factSchema },
    },
    required: [
      "active_task",
      "goal",
      "constraints",
      "decisions",
      "completed_actions",
      "current_state",
      "open_questions",
      "errors",
      "artifacts",
      "critical_facts",
    ],
    additionalProperties: false,
  },
};

const factKeys = [
  "constraints",
  "decisions",
  "completed_actions",
  "current_state",
  "open_questions",
  "errors",
  "artifacts",
  "critical_facts",
] as const;

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const normalized = value
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(normalized);
  } catch {
    const start = normalized.indexOf("{");
    const end = normalized.lastIndexOf("}");
    if (start < 0 || end <= start)
      throw new ValidationError(
        "compaction provider did not return a JSON object",
      );
    try {
      return JSON.parse(normalized.slice(start, end + 1));
    } catch {
      throw new ValidationError("compaction provider returned malformed JSON");
    }
  }
}

function parseFacts(
  key: string,
  value: unknown,
  allowedRefs?: Set<number>,
): SourceFact[] {
  if (!Array.isArray(value))
    throw new ValidationError(
      `compaction checkpoint field ${key} must be an array`,
    );
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new ValidationError(
        `compaction checkpoint field ${key} contains an invalid fact`,
      );
    const fact = entry as Record<string, unknown>;
    if (typeof fact.text !== "string" || !fact.text.trim())
      throw new ValidationError(
        `compaction checkpoint field ${key} contains empty text`,
      );
    if (
      !Array.isArray(fact.source_refs) ||
      fact.source_refs.length === 0 ||
      fact.source_refs.some(
        (ref) =>
          !Number.isInteger(ref) ||
          Number(ref) < 0 ||
          (allowedRefs && !allowedRefs.has(Number(ref))),
      )
    )
      throw new ValidationError(
        `compaction checkpoint field ${key} contains invalid source_refs`,
      );
    return {
      text: fact.text.trim(),
      source_refs: [...new Set(fact.source_refs.map(Number))].sort(
        (a, b) => a - b,
      ),
    };
  });
}

export function parseSemanticCheckpoint(
  value: unknown,
  allowedRefs?: number[],
): SemanticCheckpoint {
  const parsed = parseJson(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new ValidationError("compaction checkpoint must be a JSON object");
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.active_task !== "string" ||
    !record.active_task.trim() ||
    typeof record.goal !== "string" ||
    !record.goal.trim()
  )
    throw new ValidationError(
      "compaction checkpoint is missing active_task or goal",
    );
  const allowed = allowedRefs ? new Set(allowedRefs) : undefined;
  const result = {
    active_task: record.active_task.trim(),
    goal: record.goal.trim(),
  } as SemanticCheckpoint;
  for (const key of factKeys)
    result[key] = parseFacts(key, record[key], allowed);
  return result;
}

function uniqueFacts(values: SourceFact[]): SourceFact[] {
  const found = new Map<string, SourceFact>();
  for (const value of values) {
    const key = value.text.trim().toLowerCase();
    const previous = found.get(key);
    if (previous) {
      previous.source_refs = [
        ...new Set([...previous.source_refs, ...value.source_refs]),
      ].sort((a, b) => a - b);
    } else {
      found.set(key, {
        text: value.text.trim(),
        source_refs: [...value.source_refs],
      });
    }
  }
  return [...found.values()];
}

export function combineSemanticCheckpoints(
  parts: SemanticCheckpoint[],
): SemanticCheckpoint {
  if (!parts.length)
    throw new ValidationError("cannot combine empty compaction checkpoints");
  const latest = parts.at(-1)!;
  const result: SemanticCheckpoint = {
    active_task:
      latest.active_task ||
      parts.find((part) => part.active_task)?.active_task ||
      "",
    goal: latest.goal || parts.find((part) => part.goal)?.goal || "",
    constraints: [],
    decisions: [],
    completed_actions: [],
    current_state: [],
    open_questions: [],
    errors: [],
    artifacts: [],
    critical_facts: [],
  };
  for (const key of factKeys)
    result[key] = uniqueFacts(parts.flatMap((part) => part[key]));
  return result;
}

export function semanticSourceRefs(value: SemanticCheckpoint): number[] {
  return [
    ...new Set(
      factKeys.flatMap((key) => value[key].flatMap((fact) => fact.source_refs)),
    ),
  ].sort((a, b) => a - b);
}
