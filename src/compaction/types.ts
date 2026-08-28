import type { AgentInputItem } from "@openai/agents";
import type { CompactionSemanticRisk } from "./evaluation.js";

export type CompactionStrategy = "auto" | "native" | "portable";

export interface CompactionDecision {
  should_compact: boolean;
  reason: string;
  state: "normal" | "high" | "critical";
  estimated_tokens: number;
  effective_input_budget_tokens: number;
  reserved_output_tokens: number;
  safety_margin_tokens: number;
  request_overhead_tokens: number;
  high_watermark_tokens: number;
  low_watermark_tokens: number;
  emergency_watermark_tokens: number;
}

export interface SourceFact {
  text: string;
  source_refs: number[];
}

export interface SemanticCheckpoint {
  active_task: string;
  goal: string;
  constraints: SourceFact[];
  decisions: SourceFact[];
  completed_actions: SourceFact[];
  current_state: SourceFact[];
  open_questions: SourceFact[];
  errors: SourceFact[];
  artifacts: SourceFact[];
  critical_facts: SourceFact[];
}

export type AnchorKind =
  | "uuid"
  | "commit"
  | "issue"
  | "file"
  | "url"
  | "version"
  | "error"
  | "call_id";

export interface CompactionAnchor {
  kind: AnchorKind;
  value: string;
  source_refs: number[];
}

export interface VerbatimUserExcerpt {
  source_ref: number;
  text: string;
  truncated: boolean;
  sha256: string;
}

export interface ToolLedgerEntry {
  call_id: string;
  tool_name: string;
  arguments_digest?: string;
  arguments_sha256?: string;
  result_digest?: string;
  result_sha256?: string;
  status: "completed" | "failed" | "pending" | "unknown";
  source_refs: number[];
}

export interface PortableCheckpointV4 {
  kind: "omoikane_context_checkpoint";
  schema_version: 4;
  checkpoint_id: string;
  parent_checkpoint_id?: string;
  generation: number;
  semantic: SemanticCheckpoint;
  anchors: CompactionAnchor[];
  user_excerpts: VerbatimUserExcerpt[];
  tool_ledger: ToolLedgerEntry[];
  source: {
    from_index: number;
    to_index: number;
    item_count: number;
    checksum: string;
  };
  recovery_hint?: string;
}

export interface ProjectionValidation {
  semantic_verifiability: "structured_but_lossy" | "opaque_provider_checkpoint";
  schema_valid: boolean;
  source_ranges_complete: boolean;
  tool_pairs_valid: boolean;
  anchors_valid: boolean;
  user_excerpts_valid: boolean;
  within_token_budget: boolean;
  actual_usage_verified: boolean;
  /** Added after Projection v4 shipped; absent on older persisted v4 data. */
  semantic_risk?: CompactionSemanticRisk;
}

export interface CompactionProjectionV4 {
  version: 4;
  id: string;
  strategy: "native" | "portable";
  revision: number;
  source: {
    from_index: number;
    to_index: number;
    item_count: number;
    checksum: string;
  };
  compatibility: {
    protocol: string;
    provider?: string;
    provider_connection_id?: string;
    model?: string;
    issuer_fingerprint?: string;
    issuer_verified: boolean;
  };
  checkpoint?: PortableCheckpointV4;
  items: AgentInputItem[];
  validation: ProjectionValidation;
  recovery_ref?: Record<string, unknown>;
  checksum: string;
}

export interface CompactionUnit {
  id: string;
  kind:
    | "user_turn"
    | "assistant_turn"
    | "tool_transaction"
    | "provider_item"
    | "previous_checkpoint";
  from_index: number;
  to_index: number;
  items: AgentInputItem[];
  estimated_tokens: number;
  unresolved_tool_call: boolean;
}

export interface CompactionChunk {
  id: string;
  unit_ids: string[];
  source_refs: number[];
  checksum: string;
  text: string;
}

export interface CompactionRuntimeState {
  revision: number;
  last_input_checksum?: string;
  last_projection_id?: string;
  attempts: number;
  ineffective_attempts: number;
  last_failure_code?: string;
  cooldown_until?: string;
  actual_input_tokens?: number;
  verification_pending?: boolean;
  last_effective_input_tokens?: number;
}
