import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { ValidationError } from "./database.js";

export type StructuredOutputMode = "native" | "prompt";

export interface StructuredOutputContract {
  mode: StructuredOutputMode;
  schema: Record<string, unknown>;
}

export interface StructuredOutputIssue {
  path: string;
  keyword: string;
  message: string;
}

export class StructuredOutputError extends Error {
  readonly code = "structured_output_invalid";

  constructor(
    message: string,
    readonly details: {
      mode: StructuredOutputMode;
      stage: "parse" | "schema";
      issues: StructuredOutputIssue[];
    },
  ) {
    super(message);
    this.name = "StructuredOutputError";
  }
}

const compile = (schema: Record<string, unknown>): ValidateFunction => {
  try {
    return new Ajv({
      allErrors: true,
      strict: true,
      allowUnionTypes: true,
    }).compile(schema);
  } catch (error) {
    throw new ValidationError(
      `invalid output_schema: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

export function validateOutputSchemaDefinition(
  value: unknown,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ValidationError("output_schema must be a JSON Schema object");
  const schema = value as Record<string, unknown>;
  if (schema.type !== "object")
    throw new ValidationError(
      'output_schema root type must be exactly "object"',
    );
  compile(schema);
  return schema;
}

export function promptStructuredOutputInstruction(
  schema: Record<string, unknown>,
) {
  return `<structured_output_contract>
Your final answer after all Tool calls and Handoffs must be exactly one JSON object that validates against the JSON Schema below. Return no Markdown fence, prefix, suffix, commentary, or alternative shape. If information is unavailable, represent it only in a way permitted by the Schema. Do not invent fields.
<json_schema>${JSON.stringify(schema)}</json_schema>
</structured_output_contract>`;
}

const issues = (errors: ErrorObject[] | null | undefined) =>
  (errors ?? []).slice(0, 20).map((error) => ({
    path: error.instancePath || "/",
    keyword: error.keyword,
    message: error.message ?? "schema validation failed",
  }));

export function parseAndValidateStructuredOutput(
  output: unknown,
  contract: StructuredOutputContract,
): Record<string, unknown> {
  let parsed = output;
  if (typeof output === "string") {
    try {
      parsed = JSON.parse(output);
    } catch {
      throw new StructuredOutputError("model output is not valid JSON", {
        mode: contract.mode,
        stage: "parse",
        issues: [
          {
            path: "/",
            keyword: "parse",
            message: "expected exactly one valid JSON object",
          },
        ],
      });
    }
  }
  const validator = compile(contract.schema);
  if (!validator(parsed)) {
    throw new StructuredOutputError(
      "model output does not match output_schema",
      {
        mode: contract.mode,
        stage: "schema",
        issues: issues(validator.errors),
      },
    );
  }
  return parsed as Record<string, unknown>;
}

export function invalidStructuredOutputJson(mode: StructuredOutputMode) {
  return new StructuredOutputError("model output is not valid JSON", {
    mode,
    stage: "parse",
    issues: [
      {
        path: "/",
        keyword: "parse",
        message: "expected exactly one valid JSON object",
      },
    ],
  });
}
