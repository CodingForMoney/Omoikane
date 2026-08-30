import { z } from "zod";
import {
  API_CONTRACTS,
  ErrorResponseSchema,
  type ApiRouteContract,
} from "./contracts.js";
import { API_VERSION, OMOIKANE_VERSION } from "./runtime-versions.js";

type JsonSchema = Record<string, unknown>;

function jsonSchema(schema: z.ZodType): JsonSchema {
  const output = z.toJSONSchema(schema, {
    target: "draft-7",
    unrepresentable: "any",
  }) as JsonSchema;
  delete output.$schema;
  return output;
}

function parameters(
  schema: z.ZodType | undefined,
  location: "path" | "query" | "header",
): JsonSchema[] {
  if (!schema) return [];
  const object = jsonSchema(schema);
  const properties = (object.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((object.required ?? []) as string[]);
  return Object.entries(properties).map(([name, property]) => ({
    name,
    in: location,
    required: location === "path" || required.has(name),
    schema: property,
  }));
}

function response(
  status: number,
  schema?: z.ZodType,
  contentType = "application/json",
): JsonSchema {
  if (status === 204) return { description: "No content" };
  return {
    description: status >= 400 ? "Error" : "Success",
    content: schema
      ? { [contentType]: { schema: jsonSchema(schema) } }
      : undefined,
  };
}

export function createOpenApiDocument(): JsonSchema {
  const paths: Record<string, JsonSchema> = {};
  for (const [operationId, rawContract] of Object.entries(API_CONTRACTS)) {
    const contract: ApiRouteContract = rawContract;
    const path = contract.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
    const operation: JsonSchema = {
      operationId,
      summary: contract.summary,
      parameters: [
        ...parameters(contract.params, "path"),
        ...parameters(contract.query, "query"),
        ...parameters(contract.headers, "header"),
      ],
      responses: {
        [String(contract.responseStatus ?? 200)]:
          operationId === "streamRun"
            ? response(200, undefined, "text/event-stream")
            : operationId === "downloadArtifact"
              ? {
                  description: "Artifact bytes",
                  content: {
                    "application/octet-stream": {
                      schema: { type: "string", format: "binary" },
                    },
                  },
                }
              : response(contract.responseStatus ?? 200, contract.response),
        "404": response(404, ErrorResponseSchema),
        "409": response(409, ErrorResponseSchema),
        "413": response(413, ErrorResponseSchema),
        "422": response(422, ErrorResponseSchema),
        "429": response(429, ErrorResponseSchema),
        "500": response(500, ErrorResponseSchema),
        "502": response(502, ErrorResponseSchema),
        "503": response(503, ErrorResponseSchema),
        "507": response(507, ErrorResponseSchema),
      },
    };
    if (contract.body) {
      operation.requestBody = {
        required: !contract.bodyOptional,
        content: {
          "application/json": { schema: jsonSchema(contract.body) },
        },
      };
    } else if (contract.requestContentType === "multipart/form-data") {
      operation.requestBody = {
        required: true,
        content: {
          "multipart/form-data": {
            schema: {
              type: "object",
              properties: {
                file: { type: "string", format: "binary" },
              },
              required: ["file"],
              additionalProperties: false,
            },
          },
        },
      };
    }
    paths[path] = {
      ...(paths[path] ?? {}),
      [contract.method]: operation,
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Omoikane Runtime API",
      version: OMOIKANE_VERSION,
      description:
        "Local durable Agent Runtime. Dynamic business payloads remain open while Runtime control envelopes are strict.",
    },
    servers: [{ url: "http://127.0.0.1:8000" }],
    paths,
    "x-omoikane-api-version": API_VERSION,
  };
}

export const OPENAPI_DOCUMENT = createOpenApiDocument();
