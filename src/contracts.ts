import { z } from "zod";
import {
  ModelCapabilitySchema,
  ModelCapabilityOverrideSchema,
  ProviderSettingsSchema,
} from "./provider-capabilities.js";

export const JsonObjectSchema = z.record(z.string(), z.unknown());
export type JsonObject = z.infer<typeof JsonObjectSchema>;

const identifier = z.string().trim().min(1).max(256);
const shortText = z.string().trim().min(1).max(512);
const positiveInteger = z.number().int().positive();
const nonNegativeIntegerString = z.string().regex(/^\d+$/);
const optionalJsonObject = JsonObjectSchema.optional();
const paginationFields = {
  limit: z
    .string()
    .regex(/^[1-9]\d{0,3}$/)
    .optional(),
  cursor: z.string().min(1).max(2048).optional(),
};

export const EmptyObjectSchema = z.object({}).strict();
export const IdParamsSchema = (name: string) =>
  z.object({ [name]: identifier }).strict();

export const ProviderConnectionCreateSchema = z
  .object({
    name: shortText,
    provider: identifier,
    endpoint_profile: identifier.optional(),
    custom_base_url: z.string().url().optional(),
    custom_protocol: z
      .enum(["responses", "chat_completions", "anthropic", "google_gemini"])
      .optional(),
    api_key: z.string().min(1).max(16_384).optional(),
    api_key_env: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .optional(),
    settings: ProviderSettingsSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.api_key && !value.api_key_env)
      context.addIssue({
        code: "custom",
        path: ["api_key"],
        message: "api_key or api_key_env is required",
      });
    if (value.api_key && value.api_key_env)
      context.addIssue({
        code: "custom",
        path: ["api_key_env"],
        message: "api_key and api_key_env are mutually exclusive",
      });
  });

export const ProviderConnectionUpdateSchema = z
  .object({
    name: shortText.optional(),
    status: shortText.optional(),
    endpoint_profile: identifier.optional(),
    custom_base_url: z.string().url().optional(),
    custom_protocol: z
      .enum(["responses", "chat_completions", "anthropic", "google_gemini"])
      .optional(),
    api_key: z.string().min(1).max(16_384).optional(),
    api_key_env: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .optional(),
    default_model: identifier.optional(),
    settings: ProviderSettingsSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!Object.keys(value).length)
      context.addIssue({
        code: "custom",
        message: "at least one field is required",
      });
    if (value.api_key && value.api_key_env)
      context.addIssue({
        code: "custom",
        path: ["api_key_env"],
        message: "api_key and api_key_env are mutually exclusive",
      });
  });

export const ProviderModelCreateSchema = z
  .object({
    model_id: identifier,
    display_name: shortText.optional(),
    capabilities: ModelCapabilityOverrideSchema.optional(),
  })
  .strict();

const Base64AudioDataSchema = z
  .string()
  .min(4)
  .max(90_000_000)
  .refine(
    (value) => value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value),
    "audio data must be canonical Base64 without a data URL prefix",
  );

export const AudioTranscriptionCreateSchema = z
  .object({
    model: identifier.default("mimo-v2.5-asr"),
    audio: z
      .object({
        data: Base64AudioDataSchema,
        format: z.enum(["mp3", "wav"]),
      })
      .strict(),
    language: z.enum(["auto", "zh", "en"]).default("auto"),
  })
  .strict();

export const SpeechCreateSchema = z
  .object({
    model: identifier.default("mimo-v2.5-tts"),
    input: z.string().trim().min(1).max(32_000),
    voice: z.string().trim().min(1).max(512).optional(),
    format: z.enum(["wav", "mp3"]).default("wav"),
    instructions: z.string().trim().min(1).max(8_000).optional(),
  })
  .strict();

export const AgentDefinitionValidateSchema = z
  .object({
    document: z.string().min(1).max(2_000_000),
    overrides: optionalJsonObject,
    compilation_settings: optionalJsonObject,
  })
  .strict();

export const DeploymentCreateSchema = z
  .object({
    document: z.string().min(1).max(2_000_000).optional(),
    config: JsonObjectSchema.optional(),
    overrides: optionalJsonObject,
    compilation_settings: optionalJsonObject,
  })
  .strict()
  .superRefine((value, context) => {
    if (Boolean(value.document) === Boolean(value.config))
      context.addIssue({
        code: "custom",
        path: ["document"],
        message: "exactly one of document or config is required",
      });
  });

export const ModelInputItemSchema = JsonObjectSchema;
export const RunLimitsSchema = z
  .object({
    max_turns: positiveInteger.optional(),
    max_tool_calls: positiveInteger.optional(),
    max_handoffs: positiveInteger.optional(),
    max_duration_seconds: positiveInteger.optional(),
    approval_timeout_seconds: positiveInteger.optional(),
    max_cost_usd: z.number().optional(),
  })
  .strict();

export const RunCreateSchema = z
  .object({
    deployment_id: identifier,
    input: z.union([
      z.string(),
      z.array(ModelInputItemSchema).min(1).max(100_000),
    ]),
    conversation: z.array(ModelInputItemSchema).max(100_000).optional(),
    projection: JsonObjectSchema.optional(),
    external_session_id: identifier.optional(),
    context: JsonObjectSchema.optional(),
    limits: RunLimitsSchema.optional(),
    parent_run_id: identifier.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.conversation && value.projection)
      context.addIssue({
        code: "custom",
        path: ["projection"],
        message: "conversation and projection are mutually exclusive",
      });
  });

export const InputTokenCountSchema = z
  .object({
    input: z.union([
      z.string(),
      z.array(ModelInputItemSchema).min(1).max(100_000),
    ]),
    conversation: z.array(ModelInputItemSchema).max(100_000).optional(),
    projection: JsonObjectSchema.optional(),
    context: JsonObjectSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.conversation && value.projection)
      context.addIssue({
        code: "custom",
        path: ["projection"],
        message: "conversation and projection are mutually exclusive",
      });
  });

export const ContextCompactSchema = z
  .object({
    deployment_id: identifier,
    items: z.array(ModelInputItemSchema).max(100_000).optional(),
    projection: JsonObjectSchema.optional(),
    strategy: z.enum(["auto", "portable", "native"]).optional(),
    focus: z.string().max(100_000).optional(),
    dry_run: z.boolean().optional(),
    force: z.boolean().optional(),
    current_input: z
      .union([z.string(), JsonObjectSchema, z.array(ModelInputItemSchema)])
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Boolean(value.items) === Boolean(value.projection))
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "exactly one of items or projection is required",
      });
  });

export const RunHeadersSchema = z
  .object({
    "idempotency-key": z.string().trim().min(1).max(512),
  })
  .passthrough();
export const StreamHeadersSchema = z
  .object({ "last-event-id": nonNegativeIntegerString.optional() })
  .passthrough();
export const EventQuerySchema = z
  .object({
    after: nonNegativeIntegerString.optional(),
    limit: z.string().regex(/^\d+$/).optional(),
  })
  .strict();
export const ProviderCreateQuerySchema = z
  .object({ sync_models: z.enum(["true", "false"]).optional() })
  .strict();
export const ApprovalListQuerySchema = z
  .object({
    status: z.enum(["pending", "approved", "rejected", "expired"]).optional(),
    ...paginationFields,
  })
  .strict();
export const ResourceListQuerySchema = z
  .object({ status: identifier.optional(), ...paginationFields })
  .strict();
export const PaginationQuerySchema = z.object(paginationFields).strict();
export const RunListQuerySchema = z
  .object({
    status: z
      .enum([
        "queued",
        "running",
        "waiting_approval",
        "waiting_reconciliation",
        "completed",
        "failed",
        "cancelled",
      ])
      .optional(),
    deployment_id: identifier.optional(),
    external_session_id: identifier.optional(),
    parent_run_id: identifier.optional(),
    ...paginationFields,
  })
  .strict();

export const ApprovalDecisionSchema = z
  .object({ reason: z.string().trim().min(1).max(10_000).optional() })
  .strict();

export const ToolExecutionResolveSchema = z
  .object({
    status: z.enum(["completed", "failed"]),
    output: z.unknown().optional(),
    error: z.unknown().optional(),
    reason: z.string().trim().min(1).max(10_000),
  })
  .strict();

export const ToolCreateSchema = z
  .object({
    slug: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,127}$/),
    name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    description: z.string().min(1).max(100_000),
    kind: z.literal("function").optional(),
    implementation_key: z
      .string()
      .regex(/^[A-Za-z0-9._/-]+$/)
      .max(512),
    schema: JsonObjectSchema.optional(),
    policy: z
      .object({
        requires_approval: z.boolean().optional(),
        side_effecting: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const McpApprovalSchema = z
  .object({
    mode: z.enum(["never", "selected", "always"]),
    tools: z.array(z.string().min(1).max(256)).max(10_000).optional(),
  })
  .strict();
export const McpPolicySchema = z
  .object({
    allowed_tools: z.array(z.string().min(1).max(256)).max(10_000).optional(),
    approval: McpApprovalSchema.optional(),
    approval_required: z
      .array(z.string().min(1).max(256))
      .max(10_000)
      .optional(),
    side_effecting_tools: z
      .array(z.string().min(1).max(256))
      .max(10_000)
      .optional(),
    connect_timeout_ms: positiveInteger.optional(),
    call_timeout_ms: positiveInteger.optional(),
    max_output_bytes: positiveInteger.optional(),
  })
  .strict();
export const McpEndpointSchema = z
  .object({
    command: z.string().min(1).max(16_384).optional(),
    args: z.array(z.string().max(16_384)).max(10_000).optional(),
    cwd: z.string().min(1).max(16_384).optional(),
    env: z.record(z.string(), z.string()).optional(),
    url: z.string().url().optional(),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export const McpAuthSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }).strict(),
  z
    .object({
      type: z.literal("oauth"),
      scope_mode: z.enum(["explicit", "auto"]).optional(),
      scopes: z.array(z.string().trim().min(1).max(256)).max(256).optional(),
      write_scopes: z
        .array(z.string().trim().min(1).max(256))
        .max(256)
        .optional(),
      client_name: shortText.optional(),
      client_registration: z
        .enum(["dynamic", "metadata_url", "pre_registered"])
        .optional(),
      token_endpoint_auth_method: z
        .enum(["none", "client_secret_basic", "client_secret_post"])
        .optional(),
      client_metadata_url: z.string().url().max(4096).optional(),
      client_id_env: z
        .string()
        .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
        .optional(),
      client_secret_env: z
        .string()
        .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
        .optional(),
    })
    .strict(),
]);
const McpTransportSchema = z.enum(["stdio", "streamable_http", "sse"]);
const McpMetadataSchema = z
  .object({
    slug: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,127}$/),
    name: shortText,
  })
  .strict();
const McpSpecSchema = z
  .object({
    transport: McpTransportSchema,
    endpoint: McpEndpointSchema,
    secret_refs: z.record(z.string(), z.string()).optional(),
    auth: McpAuthSchema.optional(),
    policy: McpPolicySchema.optional(),
    execution_mode: z.literal("runtime").optional(),
  })
  .strict();
const McpDocumentCreateSchema = z
  .object({
    apiVersion: z.literal("omoikane/v1").optional(),
    kind: z.literal("McpServer").optional(),
    metadata: McpMetadataSchema,
    spec: McpSpecSchema,
  })
  .strict();
const McpLegacyCreateSchema = z
  .object({
    slug: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,127}$/),
    name: shortText,
    transport: McpTransportSchema,
    endpoint: McpEndpointSchema.optional(),
    endpoint_config: McpEndpointSchema.optional(),
    secret_refs: z.record(z.string(), z.string()).optional(),
    auth: McpAuthSchema.optional(),
    policy: McpPolicySchema.optional(),
    execution_mode: z.literal("runtime").optional(),
    status: z.string().min(1).max(64).optional(),
  })
  .strict();
export const McpServerCreateSchema = z.union([
  McpDocumentCreateSchema,
  McpLegacyCreateSchema,
]);

const McpDocumentUpdateSchema = z
  .object({
    apiVersion: z.literal("omoikane/v1").optional(),
    kind: z.literal("McpServer"),
    metadata: McpMetadataSchema.partial().strict().optional(),
    spec: McpSpecSchema.partial().strict().optional(),
  })
  .strict();
const McpLegacyUpdateSchema = McpLegacyCreateSchema.partial().strict();
export const McpServerUpdateSchema = z.union([
  McpDocumentUpdateSchema,
  McpLegacyUpdateSchema,
]);
export const McpToolCallSchema = z
  .object({ arguments: JsonObjectSchema.optional() })
  .strict();
export const McpToolInvocationSchema = z
  .object({
    arguments: JsonObjectSchema.optional(),
    operation_id: identifier.optional(),
    expected_fingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export const McpOAuthCallbackSchema = z
  .object({
    code: z.string().min(1).max(16_384).optional(),
    state: z.string().min(1).max(4096).optional(),
    iss: z.string().url().max(4096).optional(),
    error: z.string().min(1).max(256).optional(),
    error_description: z.string().max(4096).optional(),
  })
  .strict();

export const SkillImportSchema = z
  .object({ path: z.string().trim().min(1).max(16_384) })
  .strict();
export const SkillBundleSchema = z
  .object({
    files: z
      .array(
        z
          .object({
            path: z.string().trim().min(1).max(16_384),
            content_base64: z.string().max(23_000_000),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();
export const ArtifactCreateQuerySchema = z
  .object({ run_id: identifier })
  .strict();
export const ArtifactListQuerySchema = z
  .object({
    run_id: identifier,
    status: z
      .enum(["staging", "active", "deleting", "deleted", "corrupt"])
      .optional(),
    ...paginationFields,
  })
  .strict();

export const ErrorIssueSchema = z
  .object({ path: z.string(), code: z.string(), message: z.string() })
  .strict();
export const ErrorResponseSchema = z
  .object({
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        request_id: z.string(),
        details: z
          .object({ issues: z.array(ErrorIssueSchema).optional() })
          .passthrough(),
      })
      .strict(),
  })
  .strict();

export const OpenRecordSchema = z.object({}).passthrough();
export const HealthResponseSchema = z
  .object({
    status: z.literal("ok"),
    version: z.string(),
    sdk_version: z.string(),
  })
  .strict();
export const RuntimeStatusResponseSchema = z
  .object({
    status: z.literal("ok"),
    uptime_seconds: z.number().int().nonnegative(),
    workers: z
      .object({
        configured: z.number().int().nonnegative(),
        active: z.number().int().nonnegative(),
        last_activity_at: z.string().nullable(),
      })
      .strict(),
    maintenance: z
      .object({
        configured: z.boolean(),
        active: z.boolean(),
        last_success_at: z.string().nullable(),
        last_failure_at: z.string().nullable(),
      })
      .strict(),
    sse_connections: z
      .object({
        active: z.number().int().nonnegative(),
        maximum: z.number().int().positive(),
        maximum_per_run: z.number().int().positive(),
      })
      .strict(),
    runs: z
      .object({
        total: z.number().int().nonnegative(),
        by_status: z.record(z.string(), z.number().int().nonnegative()),
      })
      .strict(),
    artifacts: z
      .object({
        active_bytes: z.number().int().nonnegative(),
        maximum_file_bytes: z.number().int().positive(),
        maximum_total_bytes: z.number().int().positive(),
      })
      .strict(),
    tracing: z
      .object({
        enabled: z.boolean(),
        exporter: z.string(),
        content_policy: z.literal("metadata_only"),
        state: z.enum(["disabled", "ready", "degraded", "closed"]),
        failure_count: z.number().int().nonnegative(),
        last_export_attempt_at: z.string().nullable(),
        last_export_completed_at: z.string().nullable(),
        last_export_failure_at: z.string().nullable(),
      })
      .strict(),
  })
  .strict();
export const VersionResponseSchema = z
  .object({
    name: z.string(),
    language: z.literal("TypeScript"),
    distribution: z.literal("npm"),
    version: z.string(),
    build_commit: z.string(),
    api_version: z.number(),
    event_schema_version: z.number(),
    migration_head: z.string(),
    openai_agents_sdk_version: z.string(),
  })
  .strict();
export const CapabilitiesResponseSchema = z
  .object({
    api_versions: z.array(z.number()),
    event_schema_versions: z.array(z.number()),
    run_state_format_versions: z.array(z.number()),
    agent_definition_versions: z.array(z.string()),
    compaction_checkpoint_versions: z.array(z.number()),
    features: z.record(z.string(), z.boolean()),
  })
  .strict();
export const ListResponseSchema = z
  .object({
    data: z.array(OpenRecordSchema),
    next_cursor: z.string().nullable().optional(),
  })
  .strict();
export const ResourceRecordSchema = z
  .object({
    id: z.string(),
    kind: z.string(),
    slug: z.string().nullable().optional(),
    name: z.string().optional(),
    status: z.enum(["staging", "active", "deleting", "deleted", "corrupt"]),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
  })
  .passthrough();
export const SkillImportResponseSchema = z
  .object({
    skill: ResourceRecordSchema,
    version: ResourceRecordSchema,
    reused: z.boolean().optional(),
  })
  .strict();
export const ProviderDefinitionSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    default_profile: z.string(),
    profiles: z.record(z.string(), OpenRecordSchema),
    models: z.array(
      z
        .object({
          id: z.string(),
          display_name: z.string(),
          capabilities: ModelCapabilitySchema,
          capability_reviewed_at: z.string(),
        })
        .strict(),
    ),
  })
  .passthrough();
export const ProviderConnectionSchema = ResourceRecordSchema.extend({
  provider: z.string(),
  endpoint_profile: z.string(),
  base_url: z.string(),
  protocol: z.string(),
  settings: JsonObjectSchema,
}).passthrough();
export const ProviderModelSchema = ResourceRecordSchema.extend({
  model_id: z.string(),
  display_name: z.string(),
  capabilities: ModelCapabilitySchema,
}).passthrough();
export const ProviderValidationSchema = z
  .object({
    valid: z.boolean(),
    model_count: z.number().int().nonnegative().optional(),
    models: z.array(ProviderModelSchema).optional(),
    error: z.string().optional(),
    error_details: OpenRecordSchema.optional(),
    discovery: OpenRecordSchema.optional(),
    default_model: z.string().optional(),
    default_model_status: z
      .enum(["available", "unavailable", "unset"])
      .optional(),
  })
  .strict();
export const AudioTranscriptionResponseSchema = z
  .object({
    model: z.string(),
    text: z.string(),
    usage: JsonObjectSchema.optional(),
  })
  .strict();
export const SpeechResponseSchema = z
  .object({
    model: z.string(),
    audio: z
      .object({
        data: z.string(),
        format: z.enum(["wav", "mp3"]),
        mime_type: z.string(),
      })
      .strict(),
    usage: JsonObjectSchema.optional(),
  })
  .strict();
export const DeploymentRecordSchema = ResourceRecordSchema.extend({
  config: JsonObjectSchema,
  config_hash: z.string(),
}).passthrough();
export const InputTokenCountResponseSchema = z
  .object({
    deployment_id: z.string(),
    provider: z.string(),
    model_id: z.string(),
    input_tokens: z.number().int().nonnegative(),
    context_window_type: z.enum(["total", "input"]),
    context_window_tokens: z.number().int().positive(),
    reserved_output_tokens: z.number().int().nonnegative(),
    maximum_input_tokens: z.number().int().positive(),
    method: z.enum([
      "openai_responses_input_tokens",
      "anthropic_messages_count_tokens",
      "gemini_count_tokens",
      "zai_tokenizer",
      "official_local_tokenizer",
    ]),
    accuracy: z.enum([
      "authoritative_exact",
      "provider_estimate",
      "verified_local",
    ]),
    tokenizer_id: z.string().optional(),
    tokenizer_revision: z.string().optional(),
    counted_at: z.string(),
  })
  .strict();
export const InputTokenCountingModelSchema = z
  .object({
    provider: z.string(),
    provider_name: z.string(),
    model_id: z.string(),
    display_name: z.string(),
    context_window_tokens: z.number().int().min(1_000_000),
    context_window_type: z.enum(["total", "input"]),
    max_input_tokens: z.number().int().positive().optional(),
    max_output_tokens: z.number().int().positive().optional(),
    input_token_counting: ModelCapabilitySchema.shape.input_token_counting,
    capability_reviewed_at: z.string(),
  })
  .strict();
export const RunRecordSchema = z
  .object({
    id: z.string(),
    deployment_id: z.string(),
    status: z.string(),
    output: z.unknown().optional(),
    new_items: z.array(z.unknown()).optional(),
    projection: z.unknown().optional(),
  })
  .passthrough();
export const RunSummarySchema = z
  .object({
    id: z.string(),
    deployment_id: z.string(),
    external_session_id: z.string().nullable(),
    parent_run_id: z.string().nullable(),
    status: z.string(),
    error_code: z.string().nullable(),
    trace_id: z.string(),
    execution_attempt: z.number().int().nonnegative(),
    started_at: z.string().nullable(),
    completed_at: z.string().nullable(),
    cancel_requested: z.boolean(),
    payload_purged_at: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .strict();
export const ApprovalRecordSchema = z
  .object({ id: z.string(), run_id: z.string(), status: z.string() })
  .passthrough();
export const ToolExecutionRecordSchema = z
  .object({
    id: z.string(),
    run_id: z.string(),
    status: z.string(),
    tool_name: z.string(),
  })
  .passthrough();
export const UsageRecordSchema = z
  .object({
    id: z.string(),
    run_id: z.string(),
    provider: z.string(),
    model: z.string(),
    reporting_status: z.enum(["reported", "partial", "missing"]),
    requests: z.number(),
    input_tokens: z.number().nullable(),
    output_tokens: z.number().nullable(),
    total_tokens: z.number().nullable(),
    raw_json: JsonObjectSchema,
  })
  .passthrough();
export const McpServerRecordSchema = ResourceRecordSchema.extend({
  transport: z.enum(["stdio", "streamable_http", "sse"]),
  endpoint_config: JsonObjectSchema,
  secret_refs: z.record(z.string(), z.string()),
  auth: McpAuthSchema,
  policy: JsonObjectSchema,
}).passthrough();
export const McpOAuthStatusSchema = z
  .object({
    type: z.enum(["none", "oauth"]),
    status: z.enum([
      "not_configured",
      "disconnected",
      "authorization_pending",
      "connected",
    ]),
    server_id: z.string(),
    scope_mode: z.enum(["explicit", "auto"]),
    scopes_requested: z.array(z.string()),
    scopes_granted: z.array(z.string()),
    authorization_server: z.string().nullable(),
    authorization_url: z.string().nullable(),
    token_expires_at: z.string().datetime().nullable(),
  })
  .strict();
export const McpOAuthClientMetadataSchema = z
  .object({
    redirect_uris: z.array(z.string().url()),
    token_endpoint_auth_method: z.string().optional(),
    grant_types: z.array(z.string()).optional(),
    response_types: z.array(z.string()).optional(),
    client_name: z.string().optional(),
    scope: z.string().optional(),
  })
  .passthrough();
export const McpHealthSchema = z
  .object({
    status: z.enum(["ok", "degraded"]),
    server_id: z.string(),
    server_slug: z.string(),
    transport: z.enum(["stdio", "streamable_http", "sse"]),
    fingerprint: z.string(),
    discovered_tool_count: z.number().int().nonnegative(),
    effective_tool_count: z.number().int().nonnegative(),
    tools: z.array(z.string()),
    discovered_tools: z.array(OpenRecordSchema),
    effective_tools: z.array(OpenRecordSchema),
    blocked_tools: z.array(OpenRecordSchema),
  })
  .strict();
export const McpToolsResponseSchema = z
  .object({
    server_id: z.string(),
    fingerprint: z.string(),
    data: z.array(OpenRecordSchema),
    blocked: z.array(OpenRecordSchema),
  })
  .strict();
export const McpCallResponseSchema = z
  .object({
    output: z.unknown(),
    output_size: z.number().int().nonnegative(),
    output_sha256: z.string(),
  })
  .strict();
export const McpInvocationResponseSchema = z
  .object({
    invocation_id: z.string(),
    operation_id: z.string().nullable(),
    server_id: z.string(),
    tool_name: z.string(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    output: z.unknown(),
    output_size: z.number().int().nonnegative(),
    output_sha256: z.string(),
    started_at: z.string().datetime(),
    completed_at: z.string().datetime(),
  })
  .strict();
export const ArtifactRecordSchema = z
  .object({
    id: z.string(),
    run_id: z.string(),
    source: z.string(),
    filename: z.string(),
    sha256: z.string(),
    mime_type: z.string(),
    size: z.number().int().nonnegative(),
    lineage_json: JsonObjectSchema,
    status: z.string(),
    expires_at: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .strict();
export const CompactionResponseSchema = z
  .object({
    status: z.enum(["skipped", "dry_run", "completed"]),
    decision: OpenRecordSchema,
    id: z.string().optional(),
    strategy: z.string().optional(),
    trigger: z.string().optional(),
    summary_text: z.string().optional(),
    summary_json: JsonObjectSchema.optional(),
    metrics_json: JsonObjectSchema.optional(),
    tokens_before: z.number().optional(),
    tokens_after: z.number().optional(),
    compression_ratio: z.number().optional(),
    projection: OpenRecordSchema.optional(),
  })
  .strict();
export const RuntimeEventSchema = z
  .object({
    schema_version: z.number(),
    id: z.string(),
    run_id: z.string(),
    seq: z.number(),
    type: z.string(),
    time: z.string(),
    data: z.unknown(),
  })
  .strict();

const ReasoningMetadataCompletionReasonSchema = z.enum([
  "done",
  "stream_ended",
  "failed",
  "cancelled",
]);
const ReasoningMetadataAggregateCompletionReasonSchema = z.enum([
  ...ReasoningMetadataCompletionReasonSchema.options,
  "incomplete",
  "mixed",
]);
export const ReasoningMetadataAttemptSchema = z
  .object({
    execution_attempt: z.number().int().nonnegative(),
    item_count: z.number().int().nonnegative(),
    delta_count: z.number().int().nonnegative(),
    unicode_character_count: z.number().int().nonnegative(),
    utf8_byte_count: z.number().int().nonnegative(),
    duration_ms: z.number().int().nonnegative(),
    started_at: z.string().datetime(),
    completed_at: z.string().datetime().nullable(),
    completion_reason: ReasoningMetadataAggregateCompletionReasonSchema,
    provider_reasoning_tokens: z.number().int().nonnegative().nullable(),
    public_summary_observed: z.boolean(),
    content_available: z.literal(false),
    content_persisted: z.literal(false),
  })
  .strict();
export const ReasoningMetadataResponseSchema = z
  .object({
    run_id: z.string(),
    raw_reasoning_observed: z.boolean(),
    public_summary_observed: z.boolean(),
    provider_reasoning_tokens: z.number().int().nonnegative().nullable(),
    content_available: z.literal(false),
    content_persisted: z.literal(false),
    attempts: z.array(ReasoningMetadataAttemptSchema),
  })
  .strict();

export type ProviderConnectionCreate = z.infer<
  typeof ProviderConnectionCreateSchema
>;
export type ProviderConnectionUpdate = z.infer<
  typeof ProviderConnectionUpdateSchema
>;
export type ProviderModelCreate = z.infer<typeof ProviderModelCreateSchema>;
export type AudioTranscriptionCreate = z.input<
  typeof AudioTranscriptionCreateSchema
>;
export type SpeechCreate = z.input<typeof SpeechCreateSchema>;
export type AgentDefinitionValidate = z.infer<
  typeof AgentDefinitionValidateSchema
>;
export type DeploymentCreate = z.infer<typeof DeploymentCreateSchema>;
export type RunCreate = z.infer<typeof RunCreateSchema>;
export type InputTokenCount = z.infer<typeof InputTokenCountSchema>;
export type RunLimits = z.infer<typeof RunLimitsSchema>;
export type ContextCompact = z.infer<typeof ContextCompactSchema>;
export type ToolCreate = z.infer<typeof ToolCreateSchema>;
export type ToolExecutionResolve = z.infer<typeof ToolExecutionResolveSchema>;
export type McpServerInput = z.infer<typeof McpServerCreateSchema>;
export type McpServerUpdate = z.infer<typeof McpServerUpdateSchema>;
export type McpOAuthCallbackInput = z.infer<typeof McpOAuthCallbackSchema>;
export type SkillImport = z.infer<typeof SkillImportSchema>;
export type SkillBundle = z.infer<typeof SkillBundleSchema>;
export type ResourceRecord = z.infer<typeof ResourceRecordSchema>;
export type RunRecord = z.infer<typeof RunRecordSchema>;
export type RunSummary = z.infer<typeof RunSummarySchema>;
export interface PageResponse<T> {
  data: T[];
  next_cursor: string | null;
}
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export type RuntimeStatusResponse = z.infer<typeof RuntimeStatusResponseSchema>;
export type VersionResponse = z.infer<typeof VersionResponseSchema>;
export type CapabilitiesResponse = z.infer<typeof CapabilitiesResponseSchema>;
export type ProviderConnection = z.infer<typeof ProviderConnectionSchema>;
export type ProviderModel = z.infer<typeof ProviderModelSchema>;
export type ProviderValidation = z.infer<typeof ProviderValidationSchema>;
export type AudioTranscriptionResponse = z.infer<
  typeof AudioTranscriptionResponseSchema
>;
export type SpeechResponse = z.infer<typeof SpeechResponseSchema>;
export type DeploymentRecord = z.infer<typeof DeploymentRecordSchema>;
export type InputTokenCountResponse = z.infer<
  typeof InputTokenCountResponseSchema
>;
export type InputTokenCountingModel = z.infer<
  typeof InputTokenCountingModelSchema
>;
export type SkillImportResponse = z.infer<typeof SkillImportResponseSchema>;
export type ToolExecutionRecord = z.infer<typeof ToolExecutionRecordSchema>;
export type McpServerRecord = z.infer<typeof McpServerRecordSchema>;
export type McpOAuthStatus = z.infer<typeof McpOAuthStatusSchema>;
export type McpOAuthClientMetadata = z.infer<
  typeof McpOAuthClientMetadataSchema
>;
export type McpHealth = z.infer<typeof McpHealthSchema>;
export type McpToolsResponse = z.infer<typeof McpToolsResponseSchema>;
export type McpCallResponse = z.infer<typeof McpCallResponseSchema>;
export type McpInvocationResponse = z.infer<typeof McpInvocationResponseSchema>;
export type ArtifactRecord = z.infer<typeof ArtifactRecordSchema>;
export type CompactionResponse = z.infer<typeof CompactionResponseSchema>;
export type ReasoningMetadataAttempt = z.infer<
  typeof ReasoningMetadataAttemptSchema
>;
export type ReasoningMetadataResponse = z.infer<
  typeof ReasoningMetadataResponseSchema
>;
export type RuntimeEvent<T = unknown> = Omit<
  z.infer<typeof RuntimeEventSchema>,
  "data"
> & { data: T };

export interface ModelReasoningSummaryCoordinates {
  item_id: string | null;
  output_index: number | null;
  summary_index: number;
}

export interface ModelReasoningSummaryDeltaData extends ModelReasoningSummaryCoordinates {
  delta: string;
  execution_attempt: number;
  provisional: boolean;
  source_type: string;
  buffered?: boolean;
}

export interface ModelReasoningSummaryCompletedData extends ModelReasoningSummaryCoordinates {
  text: string;
  execution_attempt: number;
  provisional: boolean;
  source: "stream" | "reasoning_item";
  source_type: string;
  buffered?: boolean;
}

export type ModelReasoningSummaryDeltaEvent =
  RuntimeEvent<ModelReasoningSummaryDeltaData> & {
    type: "model.reasoning_summary_delta";
  };

export type ModelReasoningSummaryCompletedEvent =
  RuntimeEvent<ModelReasoningSummaryCompletedData> & {
    type: "model.reasoning_summary_completed";
  };

export interface ModelReasoningMetadataCoordinates {
  item_id: string | null;
  output_index: number | null;
  content_index: number | null;
  execution_attempt: number;
}

export interface ModelReasoningMetadataBaseData extends ModelReasoningMetadataCoordinates {
  source:
    | "responses_reasoning_text"
    | "chat_reasoning_fields"
    | "mistral_think_chunk"
    | "ai_sdk_reasoning"
    | "service_reasoning_steps";
  source_type: string;
  started_at: string;
  content_available: false;
  content_persisted: false;
}

export interface ModelReasoningMetadataStartedData extends ModelReasoningMetadataBaseData {}

export interface ModelReasoningMetadataProgressData extends ModelReasoningMetadataBaseData {
  observed_at: string;
  delta_count: number;
  unicode_character_count: number;
  utf8_byte_count: number;
  duration_ms: number;
  count_source: "delta_stream";
}

export interface ModelReasoningMetadataCompletedData extends ModelReasoningMetadataBaseData {
  completed_at: string;
  delta_count: number;
  unicode_character_count: number;
  utf8_byte_count: number;
  duration_ms: number;
  count_source: "delta_stream" | "done_fallback";
  done_event_seen: boolean;
  completion_reason: z.infer<typeof ReasoningMetadataCompletionReasonSchema>;
  provider_reasoning_tokens: number | null;
  public_summary_available: boolean;
}

export type ModelReasoningMetadataStartedEvent =
  RuntimeEvent<ModelReasoningMetadataStartedData> & {
    type: "model.reasoning_metadata_started";
  };

export type ModelReasoningMetadataProgressEvent =
  RuntimeEvent<ModelReasoningMetadataProgressData> & {
    type: "model.reasoning_metadata_progress";
  };

export type ModelReasoningMetadataCompletedEvent =
  RuntimeEvent<ModelReasoningMetadataCompletedData> & {
    type: "model.reasoning_metadata_completed";
  };

export type ModelReasoningMetadataEvent =
  | ModelReasoningMetadataStartedEvent
  | ModelReasoningMetadataProgressEvent
  | ModelReasoningMetadataCompletedEvent;

export interface ApiRouteContract {
  method: "get" | "post" | "patch" | "delete";
  path: string;
  summary: string;
  body?: z.ZodType;
  params?: z.ZodType;
  query?: z.ZodType;
  headers?: z.ZodType;
  response?: z.ZodType;
  responseStatus?: number;
  requestContentType?: string;
  bodyOptional?: boolean;
}

const connectionParams = z.object({ connectionId: identifier }).strict();
const deploymentParams = z.object({ deploymentId: identifier }).strict();
const runParams = z.object({ runId: identifier }).strict();
const executionParams = z.object({ executionId: identifier }).strict();
const approvalParams = z.object({ approvalId: identifier }).strict();
const serverParams = z.object({ serverId: identifier }).strict();
const skillParams = z.object({ skillId: identifier }).strict();
const artifactParams = z.object({ artifactId: identifier }).strict();
const mcpCallParams = z
  .object({ serverId: identifier, toolName: identifier })
  .strict();
const listOf = (schema: z.ZodType) =>
  z.object({ data: z.array(schema) }).strict();
const pageOf = (schema: z.ZodType) =>
  z
    .object({ data: z.array(schema), next_cursor: z.string().nullable() })
    .strict();

export const API_CONTRACTS = {
  health: {
    method: "get",
    path: "/healthz",
    summary: "Runtime health",
    response: HealthResponseSchema,
  },
  runtimeStatus: {
    method: "get",
    path: "/v1/runtime/status",
    summary: "Runtime worker, queue, maintenance, and tracing status",
    response: RuntimeStatusResponseSchema,
  },
  version: {
    method: "get",
    path: "/version",
    summary: "Runtime version",
    response: VersionResponseSchema,
  },
  capabilities: {
    method: "get",
    path: "/v1/capabilities",
    summary: "Runtime capabilities",
    response: CapabilitiesResponseSchema,
  },
  openapi: {
    method: "get",
    path: "/openapi.json",
    summary: "OpenAPI contract",
    response: OpenRecordSchema,
  },
  providerDefinitions: {
    method: "get",
    path: "/v1/provider-definitions",
    summary: "List Provider definitions",
    response: listOf(ProviderDefinitionSchema),
  },
  createProvider: {
    method: "post",
    path: "/v1/provider-connections",
    summary: "Create a Provider connection",
    body: ProviderConnectionCreateSchema,
    query: ProviderCreateQuerySchema,
    response: ProviderConnectionSchema,
    responseStatus: 201,
  },
  listProviders: {
    method: "get",
    path: "/v1/provider-connections",
    summary: "List Provider connections",
    query: ResourceListQuerySchema,
    response: pageOf(ProviderConnectionSchema),
  },
  getProvider: {
    method: "get",
    path: "/v1/provider-connections/:connectionId",
    summary: "Get a Provider connection",
    params: connectionParams,
    response: ProviderConnectionSchema,
  },
  updateProvider: {
    method: "patch",
    path: "/v1/provider-connections/:connectionId",
    summary: "Update a Provider connection",
    params: connectionParams,
    body: ProviderConnectionUpdateSchema,
    response: ProviderConnectionSchema,
  },
  deleteProvider: {
    method: "delete",
    path: "/v1/provider-connections/:connectionId",
    summary: "Delete an unused Provider connection",
    params: connectionParams,
    responseStatus: 204,
  },
  validateProvider: {
    method: "post",
    path: "/v1/provider-connections/:connectionId/validate",
    summary: "Validate and synchronize a Provider",
    params: connectionParams,
    body: EmptyObjectSchema,
    bodyOptional: true,
    response: ProviderValidationSchema,
  },
  listProviderModels: {
    method: "get",
    path: "/v1/provider-connections/:connectionId/models",
    summary: "List Provider models",
    params: connectionParams,
    query: PaginationQuerySchema,
    response: pageOf(ProviderModelSchema),
  },
  createProviderModel: {
    method: "post",
    path: "/v1/provider-connections/:connectionId/models",
    summary: "Add a Provider model",
    params: connectionParams,
    body: ProviderModelCreateSchema,
    response: ProviderModelSchema,
    responseStatus: 201,
  },
  transcribeAudio: {
    method: "post",
    path: "/v1/provider-connections/:connectionId/audio/transcriptions",
    summary: "Transcribe audio with a dedicated Provider model",
    params: connectionParams,
    body: AudioTranscriptionCreateSchema,
    response: AudioTranscriptionResponseSchema,
  },
  createSpeech: {
    method: "post",
    path: "/v1/provider-connections/:connectionId/audio/speech",
    summary: "Synthesize speech with a dedicated Provider model",
    params: connectionParams,
    body: SpeechCreateSchema,
    response: SpeechResponseSchema,
  },
  validateAgentDefinition: {
    method: "post",
    path: "/v1/agent-definitions/validate",
    summary: "Validate an Agent definition",
    body: AgentDefinitionValidateSchema,
    response: OpenRecordSchema,
  },
  createDeployment: {
    method: "post",
    path: "/v1/deployments",
    summary: "Create an Agent deployment",
    body: DeploymentCreateSchema,
    response: DeploymentRecordSchema,
    responseStatus: 201,
  },
  listDeployments: {
    method: "get",
    path: "/v1/deployments",
    summary: "List Agent deployments",
    query: ResourceListQuerySchema,
    response: pageOf(DeploymentRecordSchema),
  },
  getDeployment: {
    method: "get",
    path: "/v1/deployments/:deploymentId",
    summary: "Get an Agent deployment",
    params: deploymentParams,
    response: DeploymentRecordSchema,
  },
  countDeploymentInputTokens: {
    method: "post",
    path: "/v1/deployments/:deploymentId/input-token-count",
    summary: "Count the complete assembled model input",
    params: deploymentParams,
    body: InputTokenCountSchema,
    response: InputTokenCountResponseSchema,
  },
  listInputTokenCountingModels: {
    method: "get",
    path: "/v1/input-token-counting/models",
    summary:
      "List qualified input Token counting models with at least one million context Tokens",
    response: listOf(InputTokenCountingModelSchema),
  },
  compactContext: {
    method: "post",
    path: "/v1/context/compact",
    summary: "Compact model context",
    body: ContextCompactSchema,
    response: CompactionResponseSchema,
  },
  createRun: {
    method: "post",
    path: "/v1/runs",
    summary: "Create a Run",
    body: RunCreateSchema,
    headers: RunHeadersSchema,
    response: RunRecordSchema,
    responseStatus: 202,
  },
  listRuns: {
    method: "get",
    path: "/v1/runs",
    summary: "List lightweight Run summaries",
    query: RunListQuerySchema,
    response: pageOf(RunSummarySchema),
  },
  getRun: {
    method: "get",
    path: "/v1/runs/:runId",
    summary: "Get a Run",
    params: runParams,
    response: RunRecordSchema,
  },
  getRunReasoningMetadata: {
    method: "get",
    path: "/v1/runs/:runId/reasoning-metadata",
    summary: "Get metadata about raw reasoning observed during a Run",
    params: runParams,
    response: ReasoningMetadataResponseSchema,
  },
  cancelRun: {
    method: "post",
    path: "/v1/runs/:runId/cancel",
    summary: "Cancel a Run",
    params: runParams,
    body: EmptyObjectSchema,
    bodyOptional: true,
    response: RunRecordSchema,
  },
  listRunEvents: {
    method: "get",
    path: "/v1/runs/:runId/events",
    summary: "List Run events",
    params: runParams,
    query: EventQuerySchema,
    response: listOf(RuntimeEventSchema),
  },
  listToolExecutions: {
    method: "get",
    path: "/v1/runs/:runId/tool-executions",
    summary: "List Tool executions",
    params: runParams,
    response: listOf(ToolExecutionRecordSchema),
  },
  runUsage: {
    method: "get",
    path: "/v1/runs/:runId/usage",
    summary: "List Run usage",
    params: runParams,
    response: listOf(UsageRecordSchema),
  },
  resolveToolExecution: {
    method: "post",
    path: "/v1/tool-executions/:executionId/resolve",
    summary: "Reconcile a Tool execution",
    params: executionParams,
    body: ToolExecutionResolveSchema,
    response: ToolExecutionRecordSchema,
  },
  streamRun: {
    method: "get",
    path: "/v1/runs/:runId/stream",
    summary: "Stream Run events over SSE",
    params: runParams,
    headers: StreamHeadersSchema,
  },
  listApprovals: {
    method: "get",
    path: "/v1/approvals",
    summary: "List approvals",
    query: ApprovalListQuerySchema,
    response: pageOf(ApprovalRecordSchema),
  },
  getApproval: {
    method: "get",
    path: "/v1/approvals/:approvalId",
    summary: "Get an approval",
    params: approvalParams,
    response: ApprovalRecordSchema,
  },
  approve: {
    method: "post",
    path: "/v1/approvals/:approvalId/approve",
    summary: "Approve a Tool call",
    params: approvalParams,
    body: ApprovalDecisionSchema,
    bodyOptional: true,
    response: ApprovalRecordSchema,
  },
  reject: {
    method: "post",
    path: "/v1/approvals/:approvalId/reject",
    summary: "Reject a Tool call",
    params: approvalParams,
    body: ApprovalDecisionSchema,
    bodyOptional: true,
    response: ApprovalRecordSchema,
  },
  createTool: {
    method: "post",
    path: "/v1/tools",
    summary: "Register a Function Tool",
    body: ToolCreateSchema,
    response: ResourceRecordSchema,
    responseStatus: 201,
  },
  listTools: {
    method: "get",
    path: "/v1/tools",
    summary: "List Function Tools",
    query: ResourceListQuerySchema,
    response: pageOf(ResourceRecordSchema),
  },
  createMcpServer: {
    method: "post",
    path: "/v1/mcp-servers",
    summary: "Register an MCP server",
    body: McpServerCreateSchema,
    response: McpServerRecordSchema,
    responseStatus: 201,
  },
  listMcpServers: {
    method: "get",
    path: "/v1/mcp-servers",
    summary: "List MCP servers",
    query: ResourceListQuerySchema,
    response: pageOf(McpServerRecordSchema),
  },
  getMcpServer: {
    method: "get",
    path: "/v1/mcp-servers/:serverId",
    summary: "Get an MCP server",
    params: serverParams,
    response: McpServerRecordSchema,
  },
  updateMcpServer: {
    method: "patch",
    path: "/v1/mcp-servers/:serverId",
    summary: "Update an MCP server",
    params: serverParams,
    body: McpServerUpdateSchema,
    response: McpServerRecordSchema,
  },
  deleteMcpServer: {
    method: "delete",
    path: "/v1/mcp-servers/:serverId",
    summary: "Delete an MCP server",
    params: serverParams,
    responseStatus: 204,
  },
  mcpOAuthStatus: {
    method: "get",
    path: "/v1/mcp-servers/:serverId/oauth/status",
    summary: "Inspect MCP OAuth status",
    params: serverParams,
    response: McpOAuthStatusSchema,
  },
  mcpOAuthClientMetadata: {
    method: "get",
    path: "/v1/mcp-servers/:serverId/oauth/client-metadata",
    summary: "Publish URL-based MCP OAuth client metadata",
    params: serverParams,
    response: McpOAuthClientMetadataSchema,
  },
  startMcpOAuth: {
    method: "post",
    path: "/v1/mcp-servers/:serverId/oauth/start",
    summary: "Start MCP OAuth authorization",
    params: serverParams,
    body: EmptyObjectSchema,
    bodyOptional: true,
    response: McpOAuthStatusSchema,
  },
  completeMcpOAuth: {
    method: "post",
    path: "/v1/mcp-servers/:serverId/oauth/callback",
    summary: "Complete MCP OAuth authorization",
    params: serverParams,
    body: McpOAuthCallbackSchema,
    response: McpOAuthStatusSchema,
  },
  completeMcpOAuthRedirect: {
    method: "get",
    path: "/v1/mcp-servers/:serverId/oauth/callback",
    summary: "Receive an MCP OAuth browser redirect",
    params: serverParams,
    query: McpOAuthCallbackSchema,
    response: McpOAuthStatusSchema,
  },
  disconnectMcpOAuth: {
    method: "delete",
    path: "/v1/mcp-servers/:serverId/oauth",
    summary: "Delete locally stored MCP OAuth credentials",
    params: serverParams,
    responseStatus: 204,
  },
  mcpHealth: {
    method: "post",
    path: "/v1/mcp-servers/:serverId/health",
    summary: "Check MCP server health",
    params: serverParams,
    body: EmptyObjectSchema,
    bodyOptional: true,
    response: McpHealthSchema,
  },
  mcpTools: {
    method: "get",
    path: "/v1/mcp-servers/:serverId/tools",
    summary: "Inspect MCP Tools",
    params: serverParams,
    response: McpToolsResponseSchema,
  },
  callMcpTool: {
    method: "post",
    path: "/v1/mcp-servers/:serverId/tools/:toolName/call",
    summary: "Test an MCP Tool",
    params: mcpCallParams,
    body: McpToolCallSchema,
    response: McpCallResponseSchema,
  },
  invokeMcpTool: {
    method: "post",
    path: "/v1/mcp-servers/:serverId/tools/:toolName/invoke",
    summary: "Invoke an allowed read-only MCP Tool without a model Run",
    params: mcpCallParams,
    body: McpToolInvocationSchema,
    response: McpInvocationResponseSchema,
  },
  importSkill: {
    method: "post",
    path: "/v1/skills/import",
    summary: "Import a local SKILL.md",
    body: SkillImportSchema,
    response: SkillImportResponseSchema,
    responseStatus: 201,
  },
  importSkillBundle: {
    method: "post",
    path: "/v1/skills/bundles",
    summary: "Import a Skill bundle",
    body: SkillBundleSchema,
    response: SkillImportResponseSchema,
    responseStatus: 201,
  },
  listSkills: {
    method: "get",
    path: "/v1/skills",
    summary: "List Skills",
    query: ResourceListQuerySchema,
    response: pageOf(OpenRecordSchema),
  },
  listSkillVersions: {
    method: "get",
    path: "/v1/skills/:skillId/versions",
    summary: "List Skill versions",
    params: skillParams,
    query: PaginationQuerySchema,
    response: pageOf(OpenRecordSchema),
  },
  listArtifacts: {
    method: "get",
    path: "/v1/artifacts",
    summary: "List temporary Artifacts for a Run",
    query: ArtifactListQuerySchema,
    response: pageOf(ArtifactRecordSchema),
  },
  createArtifact: {
    method: "post",
    path: "/v1/artifacts",
    summary: "Upload a temporary Run artifact",
    query: ArtifactCreateQuerySchema,
    response: ArtifactRecordSchema,
    responseStatus: 201,
    requestContentType: "multipart/form-data",
  },
  getArtifact: {
    method: "get",
    path: "/v1/artifacts/:artifactId",
    summary: "Get artifact metadata",
    params: artifactParams,
    response: ArtifactRecordSchema,
  },
  downloadArtifact: {
    method: "get",
    path: "/v1/artifacts/:artifactId/download",
    summary: "Download an artifact",
    params: artifactParams,
  },
  deleteArtifact: {
    method: "delete",
    path: "/v1/artifacts/:artifactId",
    summary: "Delete an artifact",
    params: artifactParams,
    responseStatus: 204,
  },
} as const satisfies Record<string, ApiRouteContract>;

export type ApiContractName = keyof typeof API_CONTRACTS;
