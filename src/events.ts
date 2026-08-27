import type { Database, SqlExecutor } from "./database.js";
import { required } from "./database.js";
import { EVENT_SCHEMA_VERSION } from "./runtime-versions.js";
import { newId } from "./serialization.js";

export interface RunEvent extends Record<string, unknown> {
  id: string;
  run_id: string;
  seq: number;
  type: string;
  payload_json: Record<string, unknown>;
  trace_id: string | null;
  created_at: string;
}
export interface PublicRunEvent<T = unknown> {
  schema_version: number;
  id: string;
  run_id: string;
  seq: number;
  type: string;
  time: string;
  data: T;
}

export const publicEvent = (row: RunEvent): PublicRunEvent => ({
  schema_version: EVENT_SCHEMA_VERSION,
  id: row.id,
  run_id: row.run_id,
  seq: Number(row.seq),
  type: row.type,
  time: new Date(row.created_at).toISOString(),
  data: row.payload_json,
});

export class EventStore {
  constructor(
    private readonly db: Database,
    private readonly maxPayloadBytes: number,
  ) {}
  async appendInTransaction(
    tx: SqlExecutor,
    runId: string,
    type: string,
    payload: Record<string, unknown> = {},
  ): Promise<RunEvent> {
    const encoded = JSON.stringify(payload);
    if (Buffer.byteLength(encoded) > this.maxPayloadBytes)
      throw new Error(`event payload exceeds ${this.maxPayloadBytes} bytes`);
    const run = await required<{
      version: number;
      trace_id: string;
      tenant_id: string;
    }>(
      tx,
      "UPDATE runs SET version=version+1,updated_at=now() WHERE id=$1 RETURNING version,trace_id,tenant_id",
      [runId],
      "run not found",
    );
    const event = await required<RunEvent>(
      tx,
      `INSERT INTO run_events(id,run_id,seq,type,payload_json,trace_id) VALUES($1,$2,$3,$4,$5::jsonb,$6) RETURNING *`,
      [newId(), runId, run.version, type, encoded, run.trace_id],
    );
    const subscriptions = await tx.query<{
      id: string;
      event_types_json: string[];
    }>(
      "SELECT id,event_types_json FROM webhook_subscriptions WHERE tenant_id=$1 AND status='active'",
      [run.tenant_id],
    );
    for (const subscription of subscriptions.rows) {
      if (
        subscription.event_types_json.includes("*") ||
        subscription.event_types_json.includes(type)
      )
        await tx.query(
          "INSERT INTO webhook_deliveries(id,tenant_id,subscription_id,event_id) VALUES($1,$2,$3,$4) ON CONFLICT(subscription_id,event_id) DO NOTHING",
          [newId(), run.tenant_id, subscription.id, event.id],
        );
    }
    return event;
  }
  async append(
    runId: string,
    type: string,
    payload: Record<string, unknown> = {},
  ) {
    return this.db.transaction((tx) =>
      this.appendInTransaction(tx, runId, type, payload),
    );
  }
  async list(runId: string, after = 0, limit = 1000) {
    return (
      await this.db.query<RunEvent>(
        "SELECT * FROM run_events WHERE run_id=$1 AND seq>$2 ORDER BY seq LIMIT $3",
        [runId, after, Math.min(limit, 5000)],
      )
    ).rows;
  }
  async dispatchPending(limit = 100) {
    const rows = (
      await this.db.query<RunEvent>(
        "SELECT * FROM run_events WHERE published_at IS NULL AND (next_publish_at IS NULL OR next_publish_at<=now()) ORDER BY created_at LIMIT $1",
        [limit],
      )
    ).rows;
    for (const row of rows)
      await this.db.query(
        "UPDATE run_events SET published_at=now(),publish_attempts=publish_attempts+1 WHERE id=$1",
        [row.id],
      );
    return rows.length;
  }
}

export function encodeSse(event: PublicRunEvent) {
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
