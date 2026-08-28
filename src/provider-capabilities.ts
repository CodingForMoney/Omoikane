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

export const ModelCapabilitySchema = z
  .object({
    streaming: z.boolean(),
    tools: z.boolean(),
    vision: z.boolean(),
    structured_output: z.enum(["native", "prompt"]),
    context_window: z.number().int().positive().optional(),
    max_input_tokens: z.number().int().positive().optional(),
    max_output_tokens: z.number().int().positive().optional(),
    context_window_type: z.enum(["total", "input"]),
    capability_source: z.enum(["catalog", "remote", "user"]),
    capability_status: z.enum(["catalog", "unknown", "user"]),
    reasoning: ReasoningCapabilitySchema,
    context_compaction: ContextCompactionCapabilitySchema,
  })
  .strict();

export const ModelCapabilityOverrideSchema = z
  .object({
    streaming: z.boolean().optional(),
    tools: z.boolean().optional(),
    vision: z.boolean().optional(),
    structured_output: z.enum(["native", "prompt"]).optional(),
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
  .strict();

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
export type ModelCapability = z.infer<typeof ModelCapabilitySchema>;
export type ModelCapabilityOverride = z.infer<
  typeof ModelCapabilityOverrideSchema
>;

export function mergeModelCapabilities(
  base: ModelCapability,
  rawOverride: unknown,
): ModelCapability {
  const override = ModelCapabilityOverrideSchema.parse(rawOverride ?? {});
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
    reasoning,
    context_compaction: contextCompaction,
    capability_source: "user",
    capability_status: "user",
  });
}
