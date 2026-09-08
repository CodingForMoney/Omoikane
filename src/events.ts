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
  private readonly revisions = new Map<string, number>();
  private readonly waiters = new Map<string, Set<() => void>>();
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
    const run = await required<{ version: number; trace_id: string }>(
      tx,
      "UPDATE runs SET version=version+1,updated_at=now() WHERE id=$1 RETURNING version,trace_id",
      [runId],
      "run not found",
    );
    const event = await required<RunEvent>(
      tx,
      `INSERT INTO run_events(id,run_id,seq,type,payload_json,trace_id) VALUES($1,$2,$3,$4,$5::jsonb,$6) RETURNING *`,
      [newId(), runId, run.version, type, encoded, run.trace_id],
    );
    const wake = () => this.notify(runId);
    if (tx.afterCommit) tx.afterCommit(wake);
    else queueMicrotask(wake);
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

  async reasoningMetadata(runId: string) {
    return (
      await this.db.query<RunEvent>(
        `SELECT * FROM run_events
         WHERE run_id=$1 AND type IN (
           'model.reasoning_metadata_started',
           'model.reasoning_metadata_progress',
           'model.reasoning_metadata_completed',
           'model.reasoning_summary_delta',
           'model.reasoning_summary_completed'
         )
         ORDER BY seq`,
        [runId],
      )
    ).rows;
  }

  revision(runId: string) {
    return this.revisions.get(runId) ?? 0;
  }

  private notify(runId: string) {
    this.revisions.set(runId, this.revision(runId) + 1);
    const waiters = this.waiters.get(runId);
    if (!waiters) return;
    this.waiters.delete(runId);
    for (const wake of waiters) wake();
  }

  async waitForChange(
    runId: string,
    afterRevision: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ) {
    if (this.revision(runId) > afterRevision) return true;
    if (signal?.aborted) return false;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (changed: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", aborted);
        const current = this.waiters.get(runId);
        current?.delete(changedWake);
        if (current && current.size === 0) this.waiters.delete(runId);
        resolve(changed);
      };
      const changedWake = () => finish(true);
      const aborted = () => finish(false);
      const timeout = setTimeout(() => finish(false), timeoutMs);
      const current = this.waiters.get(runId) ?? new Set<() => void>();
      current.add(changedWake);
      this.waiters.set(runId, current);
      signal?.addEventListener("abort", aborted, { once: true });
      if (this.revision(runId) > afterRevision) finish(true);
    });
  }
}

export function encodeSse(event: PublicRunEvent) {
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
