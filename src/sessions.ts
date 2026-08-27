import type { AgentInputItem, Session } from "@openai/agents";
import type { Database, SqlExecutor } from "./database.js";
import { ConflictError, NotFoundError, required } from "./database.js";
import { checksum } from "./crypto.js";
import { hashJson, newId } from "./serialization.js";

export const projectionChecksum = (segments: unknown): string =>
  hashJson(segments);
export const isProjectionChecksumValid = (
  segments: unknown,
  expected: string,
): boolean =>
  expected === projectionChecksum(segments) ||
  expected === checksum(JSON.stringify(segments));

export interface SessionRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  status: string;
  scope: Record<string, unknown>;
  last_item_seq: number;
  revision: number;
  active_projection_revision: number;
  created_at: string;
  updated_at: string;
}
export interface SessionItemRow extends Record<string, unknown> {
  id: string;
  session_id: string;
  seq: number;
  item_json: AgentInputItem;
  active: boolean;
  created_at: string;
}

export class SessionService {
  constructor(private readonly db: Database) {}
  async create(tenantId: string, scope: Record<string, unknown> = {}) {
    return required<SessionRow>(
      this.db,
      "INSERT INTO sessions(id,tenant_id,scope) VALUES($1,$2,$3::jsonb) RETURNING *",
      [newId(), tenantId, JSON.stringify(scope)],
    );
  }
  async get(tenantId: string, id: string) {
    return required<SessionRow>(
      this.db,
      "SELECT * FROM sessions WHERE id=$1 AND tenant_id=$2",
      [id, tenantId],
      "session not found",
    );
  }
  async list(tenantId: string, limit = 100, offset = 0) {
    return (
      await this.db.query<SessionRow>(
        "SELECT * FROM sessions WHERE tenant_id=$1 ORDER BY updated_at DESC LIMIT $2 OFFSET $3",
        [tenantId, Math.min(limit, 500), offset],
      )
    ).rows;
  }
  async rawItems(
    sessionId: string,
    options: { activeOnly?: boolean; limit?: number; afterSeq?: number } = {},
  ) {
    const params: unknown[] = [sessionId];
    const conditions = ["session_id=$1"];
    if (options.activeOnly) {
      conditions.push("active=TRUE");
    }
    if (options.afterSeq) {
      params.push(options.afterSeq);
      conditions.push(`seq>$${params.length}`);
    }
    let limit = "";
    if (options.limit) {
      params.push(options.limit);
      limit = ` LIMIT $${params.length}`;
    }
    return (
      await this.db.query<SessionItemRow>(
        `SELECT * FROM session_items WHERE ${conditions.join(" AND ")} ORDER BY seq${limit}`,
        params,
      )
    ).rows;
  }
  async effectiveItems(sessionId: string): Promise<AgentInputItem[]> {
    const session = await required<SessionRow>(
      this.db,
      "SELECT * FROM sessions WHERE id=$1",
      [sessionId],
      "session not found",
    );
    if (session.active_projection_revision > 0) {
      const projection = await this.db.query<{
        segments_json: Array<{ item_json: AgentInputItem }>;
        source_to_seq: number;
        checksum: string;
      }>(
        "SELECT segments_json,source_to_seq,checksum FROM context_projections WHERE session_id=$1 AND revision=$2 AND status='active'",
        [sessionId, session.active_projection_revision],
      );
      if (
        projection.rows[0] &&
        isProjectionChecksumValid(
          projection.rows[0].segments_json,
          projection.rows[0].checksum,
        )
      ) {
        const summary = projection.rows[0].segments_json.map(
          (segment) => segment.item_json,
        );
        const tail = (
          await this.rawItems(sessionId, {
            afterSeq: projection.rows[0].source_to_seq,
          })
        ).map((row) => row.item_json);
        return [...summary, ...tail];
      }
    }
    return (await this.rawItems(sessionId, { activeOnly: true })).map(
      (row) => row.item_json,
    );
  }
  async append(
    sessionId: string,
    items: AgentInputItem[],
    executor: SqlExecutor = this.db,
  ) {
    if (!items.length) return;
    const session = await required<SessionRow>(
      executor,
      "SELECT * FROM sessions WHERE id=$1 FOR UPDATE",
      [sessionId],
      "session not found",
    );
    let seq = session.last_item_seq;
    for (const item of items) {
      seq += 1;
      await executor.query(
        "INSERT INTO session_items(id,session_id,seq,item_json) VALUES($1,$2,$3,$4::jsonb)",
        [newId(), sessionId, seq, JSON.stringify(item)],
      );
    }
    await executor.query(
      "UPDATE sessions SET last_item_seq=$2,revision=revision+1,updated_at=now() WHERE id=$1",
      [sessionId, seq],
    );
  }
  async appendTransactional(sessionId: string, items: AgentInputItem[]) {
    await this.db.transaction((tx) => this.append(sessionId, items, tx));
  }
  async pop(sessionId: string): Promise<AgentInputItem | undefined> {
    return this.db.transaction(async (tx) => {
      const row = (
        await tx.query<SessionItemRow>(
          "SELECT * FROM session_items WHERE session_id=$1 ORDER BY seq DESC LIMIT 1 FOR UPDATE",
          [sessionId],
        )
      ).rows[0];
      if (!row) return undefined;
      await tx.query("DELETE FROM session_items WHERE id=$1", [row.id]);
      await tx.query(
        "UPDATE context_projections SET status='invalidated',updated_at=now() WHERE session_id=$1",
        [sessionId],
      );
      await tx.query(
        "UPDATE compactions SET status='invalidated',failure_reason='session history was destructively modified',updated_at=now() WHERE session_id=$1",
        [sessionId],
      );
      await tx.query(
        "UPDATE sessions SET last_item_seq=COALESCE((SELECT max(seq) FROM session_items WHERE session_id=$1),0),revision=revision+1,active_projection_revision=0,updated_at=now() WHERE id=$1",
        [sessionId],
      );
      return row.item_json;
    });
  }
  async clear(sessionId: string) {
    await this.db.transaction(async (tx) => {
      const result = await tx.query(
        "DELETE FROM session_items WHERE session_id=$1",
        [sessionId],
      );
      await tx.query(
        "UPDATE context_projections SET status='invalidated',updated_at=now() WHERE session_id=$1",
        [sessionId],
      );
      await tx.query(
        "UPDATE compactions SET status='invalidated',failure_reason='session history was cleared',updated_at=now() WHERE session_id=$1",
        [sessionId],
      );
      await tx.query(
        "UPDATE sessions SET last_item_seq=0,revision=revision+1,active_projection_revision=0,updated_at=now() WHERE id=$1",
        [sessionId],
      );
      return result;
    });
  }
  async chatMessages(sessionId: string) {
    const rows = await this.rawItems(sessionId);
    return rows.flatMap((row) => {
      const item = row.item_json as unknown as Record<string, unknown>;
      const role = String(
        item.role ?? (item.type === "message" ? "assistant" : "unknown"),
      );
      const content = item.content;
      let text = "";
      if (typeof content === "string") text = content;
      else if (Array.isArray(content))
        text = content
          .map((part) =>
            typeof part === "string"
              ? part
              : String((part as Record<string, unknown>).text ?? ""),
          )
          .join("");
      if (!text && typeof item.text === "string") text = item.text;
      return text
        ? [
            {
              id: row.id,
              seq: row.seq,
              role,
              content: text,
              item: item,
              created_at: row.created_at,
            },
          ]
        : [];
    });
  }
}

export class DatabaseSession implements Session {
  constructor(
    private readonly service: SessionService,
    private readonly id: string,
  ) {}
  async getSessionId() {
    return this.id;
  }
  async getItems(limit?: number) {
    const items = await this.service.effectiveItems(this.id);
    return limit === undefined ? items : items.slice(-limit);
  }
  async addItems(items: AgentInputItem[]) {
    await this.service.appendTransactional(this.id, items);
  }
  async popItem() {
    return this.service.pop(this.id);
  }
  async clearSession() {
    await this.service.clear(this.id);
  }
}

export function sessionItemText(item: unknown): string {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return String(item ?? "");
  const record = item as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  if (typeof record.content === "string") return record.content;
  if (Array.isArray(record.content))
    return record.content.map(sessionItemText).filter(Boolean).join("\n");
  return "";
}
