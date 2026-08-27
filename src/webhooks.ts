import { createHmac } from "node:crypto";
import type { Settings } from "./config.js";
import type { Database } from "./database.js";
import { ConflictError, required } from "./database.js";
import { StateCipher } from "./crypto.js";
import { newId } from "./serialization.js";
import { publicEvent, type RunEvent } from "./events.js";

export class WebhookService {
  private readonly cipher: StateCipher;
  private stopped = false;
  constructor(
    private readonly db: Database,
    private readonly settings: Settings,
  ) {
    this.cipher = new StateCipher(settings.runStateSecret);
  }
  async create(tenantId: string, input: Record<string, unknown>) {
    const secret = String(input.secret);
    const encrypted = this.cipher.encrypt(secret);
    return required(
      this.db,
      `INSERT INTO webhook_subscriptions(id,tenant_id,name,url,event_types_json,secret_ciphertext,secret_checksum,max_attempts)
    VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8) RETURNING id,tenant_id,name,url,event_types_json,status,max_attempts,created_at,updated_at`,
      [
        newId(),
        tenantId,
        input.name,
        input.url,
        JSON.stringify(input.event_types ?? ["*"]),
        encrypted.ciphertext,
        encrypted.checksum,
        Number(input.max_attempts ?? 10),
      ],
    );
  }
  async list(tenantId: string) {
    return (
      await this.db.query(
        "SELECT id,tenant_id,name,url,event_types_json,status,max_attempts,created_at,updated_at FROM webhook_subscriptions WHERE tenant_id=$1 ORDER BY created_at DESC",
        [tenantId],
      )
    ).rows;
  }
  async patch(tenantId: string, id: string, input: Record<string, unknown>) {
    const current = await required<Record<string, unknown>>(
      this.db,
      "SELECT * FROM webhook_subscriptions WHERE id=$1 AND tenant_id=$2",
      [id, tenantId],
      "webhook subscription not found",
    );
    let ciphertext = current.secret_ciphertext,
      checksum = current.secret_checksum;
    if (input.secret) {
      const encrypted = this.cipher.encrypt(String(input.secret));
      ciphertext = encrypted.ciphertext;
      checksum = encrypted.checksum;
    }
    return required(
      this.db,
      `UPDATE webhook_subscriptions SET url=$3,event_types_json=$4::jsonb,secret_ciphertext=$5,secret_checksum=$6,status=$7,max_attempts=$8,updated_at=now() WHERE id=$1 AND tenant_id=$2 RETURNING id,tenant_id,name,url,event_types_json,status,max_attempts,created_at,updated_at`,
      [
        id,
        tenantId,
        input.url ?? current.url,
        JSON.stringify(input.event_types ?? current.event_types_json),
        ciphertext,
        checksum,
        input.status ?? current.status,
        input.max_attempts ?? current.max_attempts,
      ],
    );
  }
  async deliveries(tenantId: string, status?: string) {
    return (
      await this.db.query(
        `SELECT d.*,s.name subscription_name,s.url FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id=d.subscription_id WHERE d.tenant_id=$1 ${status ? "AND d.status=$2" : ""} ORDER BY d.created_at DESC LIMIT 1000`,
        status ? [tenantId, status] : [tenantId],
      )
    ).rows;
  }
  async replay(tenantId: string, id: string) {
    const row = await required<Record<string, unknown>>(
      this.db,
      "SELECT * FROM webhook_deliveries WHERE id=$1 AND tenant_id=$2",
      [id, tenantId],
      "webhook delivery not found",
    );
    if (row.status === "pending")
      throw new ConflictError("delivery is already pending");
    return required(
      this.db,
      "UPDATE webhook_deliveries SET status='pending',next_attempt_at=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1 RETURNING *",
      [id],
    );
  }
  async processNext() {
    const worker = `webhook:${process.pid}`;
    const delivery = await this.db.transaction(async (tx) => {
      const row = (
        await tx.query<Record<string, unknown>>(
          `SELECT * FROM webhook_deliveries WHERE status='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=now()) ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
        )
      ).rows[0];
      if (!row) return undefined;
      await tx.query(
        "UPDATE webhook_deliveries SET status='delivering',lease_owner=$2,lease_expires_at=now()+interval '60 seconds',updated_at=now() WHERE id=$1",
        [row.id, worker],
      );
      return row;
    });
    if (!delivery) return false;
    const subscription = await required<Record<string, unknown>>(
      this.db,
      "SELECT * FROM webhook_subscriptions WHERE id=$1",
      [delivery.subscription_id],
    );
    const event = await required<RunEvent>(
      this.db,
      "SELECT * FROM run_events WHERE id=$1",
      [delivery.event_id],
    );
    const body = JSON.stringify(publicEvent(event));
    const secret = this.cipher.decrypt(
      subscription.secret_ciphertext as Uint8Array,
      String(subscription.secret_checksum),
    );
    const signature = createHmac("sha256", secret).update(body).digest("hex");
    try {
      const response = await fetch(String(subscription.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-omoikane-event-id": event.id,
          "x-omoikane-signature": `sha256=${signature}`,
        },
        body,
        signal: AbortSignal.timeout(this.settings.webhookTimeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await this.db.query(
        "UPDATE webhook_deliveries SET status='delivered',attempts=attempts+1,response_status=$2,delivered_at=now(),lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1",
        [delivery.id, response.status],
      );
    } catch (error) {
      const attempts = Number(delivery.attempts) + 1;
      const terminal = attempts >= Number(subscription.max_attempts);
      await this.db.query(
        "UPDATE webhook_deliveries SET status=$2,attempts=$3,last_error=$4,next_attempt_at=CASE WHEN $2='pending' THEN now()+($5 || ' seconds')::interval ELSE NULL END,lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1",
        [
          delivery.id,
          terminal ? "failed" : "pending",
          attempts,
          String(error).slice(0, 2000),
          Math.min(3600, 2 ** attempts),
        ],
      );
    }
    return true;
  }
  async runForever(signal?: AbortSignal) {
    while (!this.stopped && !signal?.aborted) {
      if (!(await this.processNext()))
        await new Promise((resolve) =>
          setTimeout(resolve, this.settings.workerPollMs),
        );
    }
  }
  stop() {
    this.stopped = true;
  }
}
