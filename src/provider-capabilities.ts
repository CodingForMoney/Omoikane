import { z } from "zod";

export const ReasoningCapabilitySchema = z
  .object({
    supported: z.boolean(),
    effort_values: z.array(z.string().trim().min(1)).max(32),
    adapter: z.literal("reasoning_effort").optional(),
    value_map: z.record(z.string(), z.string()).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.supported && !value.effort_values.length)
      context.addIssue({
        code: "custom",
        path: ["effort_values"],
        message: "supported reasoning requires at least one effort value",
      });
    if (!value.supported && value.effort_values.length)
      context.addIssue({
        code: "custom",
        path: ["effort_values"],
        message: "unsupported reasoning cannot declare effort values",
      });
  });

export const ContextCompactionCapabilitySchema = z
  .object({
    supported: z.boolean(),
    method: z.literal("responses_compact").optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.supported && !value.method)
      context.addIssue({
        code: "custom",
        path: ["method"],
        message: "supported context compaction requires a method",
      });
    if (!value.supported && value.method)
      context.addIssue({
        code: "custom",
        path: ["method"],
        message: "unsupported context compaction cannot declare a method",
      });
  });

export const InputTokenCountingCapabilitySchema = z
  .object({
    status: z.enum(["qualified", "unavailable"]),
    scope: z.literal("assembled_model_input").optional(),
    method: z
      .enum([
        "openai_responses_input_tokens",
        "anthropic_messages_count_tokens",
        "gemini_count_tokens",
        "zai_tokenizer",
        "official_local_tokenizer",
      ])
      .optional(),
    accuracy: z
      .enum(["authoritative_exact", "provider_estimate", "verified_local"])
      .optional(),
    tokenizer_id: z.string().trim().min(1).optional(),
    tokenizer_revision: z.string().trim().min(1).optional(),
    supported_input_modalities: z
      .array(z.enum(["text", "image", "audio", "video"]))
      .min(1)
      .optional(),
    reviewed_at: z.string().trim().min(1).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const required = [
      ["scope", value.scope],
      ["method", value.method],
      ["accuracy", value.accuracy],
      ["reviewed_at", value.reviewed_at],
    ] as const;
    if (value.status === "qualified") {
      for (const [field, fieldValue] of required)
        if (!fieldValue)
          context.addIssue({
            code: "custom",
            path: [field],
            message: `qualified input Token counting requires ${field}`,
          });
      if (
        value.method === "official_local_tokenizer" &&
        (!value.tokenizer_id ||
          !value.tokenizer_revision ||
          !value.supported_input_modalities?.length)
      )
        context.addIssue({
          code: "custom",
          path: ["supported_input_modalities"],
          message:
            "qualified local input Token counting requires tokenizer_id, tokenizer_revision, and supported input modalities",
        });
    } else if (
      value.scope ||
      value.method ||
      value.accuracy ||
      value.tokenizer_id ||
      value.tokenizer_revision ||
      value.supported_input_modalities ||
      value.reviewed_at
    )
      context.addIssue({
        code: "custom",
        message:
          "unavailable input Token counting cannot declare qualification evidence",
      });
  });

export const ModelInputModalitySchema = z.enum([
  "text",
  "image",
  "audio",
  "video",
]);
export const ModelOutputModalitySchema = z.enum(["text", "audio"]);
export const ModelKindSchema = z.enum([
  "agent",
  "transcription",
  "speech_synthesis",
  "routing",
]);
export const ModelTaskCapabilitySchema = z
  .object({
    image_understanding: z.enum(["none", "native"]),
    transcription: z.enum(["none", "general", "dedicated"]),
    speech_synthesis: z.enum(["none", "dedicated"]),
  })
  .strict();

const uniqueModalities = <T extends string>(values: T[]) =>
  new Set(values).size === values.length;

export const ModelCapabilitySchema = z
  .object({
    model_kind: ModelKindSchema,
    input_modalities: z
      .array(ModelInputModalitySchema)
      .min(1)
      .refine(uniqueModalities, "input modalities must be unique"),
    output_modalities: z
      .array(ModelOutputModalitySchema)
      .min(1)
      .refine(uniqueModalities, "output modalities must be unique"),
    tasks: ModelTaskCapabilitySchema,
    streaming: z.boolean(),
    tools: z.boolean(),
    /** @deprecated Read tasks.image_understanding or input_modalities instead. */
    vision: z.boolean(),
    structured_output: z.enum(["none", "native", "prompt"]),
    context_window: z.number().int().positive().optional(),
    max_input_tokens: z.number().int().positive().optional(),
    max_output_tokens: z.number().int().positive().optional(),
    context_window_type: z.enum(["total", "input"]),
    capability_source: z.enum(["catalog", "remote", "user"]),
    capability_status: z.enum(["catalog", "unknown", "user"]),
    reasoning: ReasoningCapabilitySchema,
    context_compaction: ContextCompactionCapabilitySchema,
    input_token_counting: InputTokenCountingCapabilitySchema,
  })
  .strict()
  .superRefine((value, context) => {
    const imageUnderstanding = value.tasks.image_understanding === "native";
    const imageInput = value.input_modalities.includes("image");
    if (
      value.vision !== imageUnderstanding ||
      imageInput !== imageUnderstanding
    )
      context.addIssue({
        code: "custom",
        path: ["tasks", "image_understanding"],
        message:
          "vision, image input, and native image understanding must agree",
      });
    if (
      value.tasks.transcription !== "none" &&
      (!value.input_modalities.includes("audio") ||
        !value.output_modalities.includes("text"))
    )
      context.addIssue({
        code: "custom",
        path: ["tasks", "transcription"],
        message: "transcription requires audio input and text output",
      });
    if (
      value.tasks.speech_synthesis !== "none" &&
      (!value.input_modalities.includes("text") ||
        !value.output_modalities.includes("audio"))
    )
      context.addIssue({
        code: "custom",
        path: ["tasks", "speech_synthesis"],
        message: "speech synthesis requires text input and audio output",
      });
  });

export const ModelCapabilityOverrideSchema = z
  .object({
    model_kind: ModelKindSchema.optional(),
    input_modalities: z
      .array(ModelInputModalitySchema)
      .min(1)
      .refine(uniqueModalities, "input modalities must be unique")
      .optional(),
    output_modalities: z
      .array(ModelOutputModalitySchema)
      .min(1)
      .refine(uniqueModalities, "output modalities must be unique")
      .optional(),
    tasks: z
      .object({
        image_understanding: z.enum(["none", "native"]).optional(),
        transcription: z.enum(["none", "general", "dedicated"]).optional(),
        speech_synthesis: z.enum(["none", "dedicated"]).optional(),
      })
      .strict()
      .optional(),
    streaming: z.boolean().optional(),
    tools: z.boolean().optional(),
    /** @deprecated Set tasks.image_understanding and input_modalities. */
    vision: z.boolean().optional(),
    structured_output: z.enum(["none", "native", "prompt"]).optional(),
    context_window: z.number().int().positive().optional(),
    max_input_tokens: z.number().int().positive().optional(),
    max_output_tokens: z.number().int().positive().optional(),
    context_window_type: z.enum(["total", "input"]).optional(),
    reasoning: z
      .object({
        supported: z.boolean().optional(),
        effort_values: z.array(z.string().trim().min(1)).max(32).optional(),
        adapter: z.literal("reasoning_effort").optional(),
        value_map: z.record(z.string(), z.string()).optional(),
      })
      .strict()
      .optional(),
    context_compaction: z
      .object({
        supported: z.boolean().optional(),
        method: z.literal("responses_compact").optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const taskImage = value.tasks?.image_understanding;
    const declaredImage =
      taskImage === undefined ? value.vision : taskImage === "native";
    if (
      value.vision !== undefined &&
      taskImage !== undefined &&
      value.vision !== (taskImage === "native")
    )
      context.addIssue({
        code: "custom",
        path: ["tasks", "image_understanding"],
        message: "vision and image understanding overrides conflict",
      });
    if (
      value.input_modalities &&
      declaredImage !== undefined &&
      value.input_modalities.includes("image") !== declaredImage
    )
      context.addIssue({
        code: "custom",
        path: ["input_modalities"],
        message: "image input and image understanding overrides conflict",
      });
  });

export const ProviderSettingsSchema = z
  .object({
    model_discovery_timeout_ms: z
      .number()
      .int()
      .min(1_000)
      .max(60_000)
      .optional(),
    model_discovery_max_retries: z.number().int().min(0).max(2).optional(),
  })
  .passthrough();

export type ReasoningCapability = z.infer<typeof ReasoningCapabilitySchema>;
export type ContextCompactionCapability = z.infer<
  typeof ContextCompactionCapabilitySchema
>;
export type InputTokenCountingCapability = z.infer<
  typeof InputTokenCountingCapabilitySchema
>;
export type ModelInputModality = z.infer<typeof ModelInputModalitySchema>;
export type ModelOutputModality = z.infer<typeof ModelOutputModalitySchema>;
export type ModelKind = z.infer<typeof ModelKindSchema>;
export type ModelTaskCapability = z.infer<typeof ModelTaskCapabilitySchema>;
export type ModelCapability = z.infer<typeof ModelCapabilitySchema>;
export type ModelCapabilityOverride = z.infer<
  typeof ModelCapabilityOverrideSchema
>;

export function mergeModelCapabilities(
  base: ModelCapability,
  rawOverride: unknown,
): ModelCapability {
  const override = ModelCapabilityOverrideSchema.parse(rawOverride ?? {});
  const tasks = {
    ...base.tasks,
    ...(override.tasks ?? {}),
  };
  let inputModalities = override.input_modalities
    ? [...override.input_modalities]
    : [...base.input_modalities];
  let outputModalities = override.output_modalities
    ? [...override.output_modalities]
    : [...base.output_modalities];
  const explicitImageUnderstanding = override.tasks?.image_understanding;
  const imageUnderstanding =
    explicitImageUnderstanding ??
    (override.vision === undefined
      ? override.input_modalities
        ? override.input_modalities.includes("image")
          ? "native"
          : "none"
        : base.tasks.image_understanding
      : override.vision
        ? "native"
        : "none");
  tasks.image_understanding = imageUnderstanding;
  if (!override.input_modalities) {
    inputModalities = inputModalities.filter((item) => item !== "image");
    if (imageUnderstanding === "native") inputModalities.push("image");
  }
  if (tasks.transcription !== "none" && !override.input_modalities)
    inputModalities.push("audio");
  if (tasks.transcription !== "none" && !override.output_modalities)
    outputModalities.push("text");
  if (tasks.speech_synthesis !== "none" && !override.input_modalities)
    inputModalities.push("text");
  if (tasks.speech_synthesis !== "none" && !override.output_modalities)
    outputModalities.push("audio");
  inputModalities = [...new Set(inputModalities)];
  outputModalities = [...new Set(outputModalities)];
  const reasoning = {
    ...base.reasoning,
    ...(override.reasoning ?? {}),
  };
  if (override.reasoning?.supported === false) {
    reasoning.effort_values = override.reasoning.effort_values ?? [];
    delete reasoning.adapter;
    delete reasoning.value_map;
  }
  const contextCompaction = {
    ...base.context_compaction,
    ...(override.context_compaction ?? {}),
  };
  if (override.context_compaction?.supported === false)
    delete contextCompaction.method;
  return ModelCapabilitySchema.parse({
    ...base,
    ...override,
    input_modalities: inputModalities,
    output_modalities: outputModalities,
    tasks,
    vision: imageUnderstanding === "native",
    reasoning,
    context_compaction: contextCompaction,
    input_token_counting: base.input_token_counting,
    capability_source: "user",
    capability_status: "user",
  });
}

/** Upgrade a persisted pre-modality capability record without changing its meaning. */
export function normalizeModelCapabilities(rawValue: unknown): ModelCapability {
  const raw =
    rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)
      ? ({ ...rawValue } as Record<string, unknown>)
      : {};
  const legacyVision = raw.vision === true;
  const rawTasks =
    raw.tasks && typeof raw.tasks === "object" && !Array.isArray(raw.tasks)
      ? (raw.tasks as Record<string, unknown>)
      : {};
  if (raw.input_token_counting === undefined)
    raw.input_token_counting = { status: "unavailable" };
  const inputModalities = Array.isArray(raw.input_modalities)
    ? raw.input_modalities
    : legacyVision
      ? ["text", "image"]
      : ["text"];
  const tasks = {
    image_understanding:
      rawTasks.image_understanding ??
      (inputModalities.includes("image") || legacyVision ? "native" : "none"),
    transcription: rawTasks.transcription ?? "none",
    speech_synthesis: rawTasks.speech_synthesis ?? "none",
  };
  return ModelCapabilitySchema.parse({
    ...raw,
    model_kind: raw.model_kind ?? "agent",
    input_modalities: inputModalities,
    output_modalities: raw.output_modalities ?? ["text"],
    tasks,
    vision: tasks.image_understanding === "native",
  });
}
