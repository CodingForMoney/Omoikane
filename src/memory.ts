import { createHash } from "node:crypto";
import type { Database } from "./database.js";
import { NotFoundError, required } from "./database.js";
import { checksum } from "./crypto.js";
import { newId } from "./serialization.js";

interface MemoryRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  scope_type: string;
  scope_id: string;
  kind: string;
  content: string;
  content_hash: string;
  embedding_json: number[];
  confidence: number;
  enabled: boolean;
  valid_from: string;
  valid_to: string | null;
  superseded_by: string | null;
  source_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export function hashEmbedding(text: string, dimensions = 128): number[] {
  const bytes = createHash("sha256").update(text.toLowerCase()).digest();
  const values = Array.from(
    { length: dimensions },
    (_, i) => bytes[i % bytes.length]! / 127.5 - 1,
  );
  const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0)) || 1;
  return values.map((v) => v / norm);
}
const cosine = (a: number[], b: number[]) =>
  a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0);

export class MemoryService {
  constructor(private readonly db: Database) {}
  async create(
    tenantId: string,
    input: Record<string, unknown>,
    source: Record<string, unknown> = {},
  ) {
    const content = String(input.content);
    const id = newId();
    return required<MemoryRow>(
      this.db,
      `INSERT INTO memories(id,tenant_id,scope_type,scope_id,kind,content,content_hash,embedding_json,confidence,source_json)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb) RETURNING *`,
      [
        id,
        tenantId,
        String(input.scope_type),
        String(input.scope_id),
        String(input.kind ?? "semantic"),
        content,
        checksum(content),
        JSON.stringify(hashEmbedding(content)),
        Number(input.confidence ?? 0.8),
        JSON.stringify(source),
      ],
    );
  }
  async list(tenantId: string, filters: Record<string, unknown> = {}) {
    const params: unknown[] = [tenantId];
    const conditions = ["tenant_id=$1"];
    for (const key of ["scope_type", "scope_id", "kind"]) {
      if (filters[key] !== undefined) {
        params.push(filters[key]);
        conditions.push(`${key}=$${params.length}`);
      }
    }
    if (filters.enabled !== undefined) {
      params.push(Boolean(filters.enabled));
      conditions.push(`enabled=$${params.length}`);
    }
    params.push(Math.min(Number(filters.limit ?? 200), 1000));
    return (
      await this.db.query<MemoryRow>(
        `SELECT * FROM memories WHERE ${conditions.join(" AND ")} ORDER BY updated_at DESC LIMIT $${params.length}`,
        params,
      )
    ).rows;
  }
  async patch(tenantId: string, id: string, input: Record<string, unknown>) {
    const current = await required<MemoryRow>(
      this.db,
      "SELECT * FROM memories WHERE id=$1 AND tenant_id=$2",
      [id, tenantId],
      "memory not found",
    );
    const content =
      input.content === undefined ? current.content : String(input.content);
    return required<MemoryRow>(
      this.db,
      `UPDATE memories SET content=$3,content_hash=$4,embedding_json=$5::jsonb,confidence=$6,enabled=$7,updated_at=now() WHERE id=$1 AND tenant_id=$2 RETURNING *`,
      [
        id,
        tenantId,
        content,
        checksum(content),
        JSON.stringify(hashEmbedding(content)),
        input.confidence === undefined
          ? current.confidence
          : Number(input.confidence),
        input.enabled === undefined ? current.enabled : Boolean(input.enabled),
      ],
    );
  }
  async remove(tenantId: string, id: string) {
    const result = await this.db.query(
      "DELETE FROM memories WHERE id=$1 AND tenant_id=$2",
      [id, tenantId],
    );
    if (!result.rowCount) throw new NotFoundError("memory not found");
  }
  async retrieve(
    tenantId: string,
    query: string,
    scopes: Array<[string, string]>,
    limit = 8,
  ) {
    if (!scopes.length) return [];
    const rows = await this.list(tenantId, { enabled: true, limit: 1000 });
    const allowed = new Set(scopes.map(([type, id]) => `${type}:${id}`));
    const vector = hashEmbedding(query);
    return rows
      .filter((row) => allowed.has(`${row.scope_type}:${row.scope_id}`))
      .map((row) => ({
        ...row,
        similarity: cosine(vector, row.embedding_json),
      }))
      .sort((a, b) => b.similarity * b.confidence - a.similarity * a.confidence)
      .slice(0, limit);
  }
  async consolidateRun(
    tenantId: string,
    run: {
      id: string;
      agent_version_id: string;
      input_json: unknown;
      output_json: unknown;
    },
  ) {
    if (run.output_json === undefined || run.output_json === null)
      return undefined;
    const content =
      `Input: ${typeof run.input_json === "string" ? run.input_json : JSON.stringify(run.input_json)}\nOutcome: ${typeof run.output_json === "string" ? run.output_json : JSON.stringify(run.output_json)}`.slice(
        0,
        50_000,
      );
    return this.create(
      tenantId,
      {
        scope_type: "agent",
        scope_id: run.agent_version_id,
        kind: "episodic",
        content,
        confidence: 0.65,
      },
      { run_id: run.id },
    );
  }
}
