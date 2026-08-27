import type { Database, SqlExecutor } from "./database.js";
import { required } from "./database.js";
import { newId } from "./serialization.js";

export class BudgetExceeded extends Error {}
export class CostService {
  constructor(private readonly db: Database) {}
  async createPrice(input: Record<string, unknown>) {
    return required(
      this.db,
      `INSERT INTO price_catalog(id,provider,model,version,input_per_million,output_per_million,currency,effective_from,effective_to)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        newId(),
        input.provider,
        input.model,
        input.version,
        Number(input.input_per_million),
        Number(input.output_per_million),
        input.currency ?? "USD",
        input.effective_from,
        input.effective_to ?? null,
      ],
    );
  }
  async price(
    provider: string,
    model: string,
    executor: SqlExecutor = this.db,
  ) {
    return (
      await executor.query<Record<string, unknown>>(
        `SELECT * FROM price_catalog WHERE provider=$1 AND model=$2 AND effective_from<=now() AND (effective_to IS NULL OR effective_to>now()) ORDER BY effective_from DESC LIMIT 1`,
        [provider, model],
      )
    ).rows[0];
  }
  async estimate(
    provider: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    executor: SqlExecutor = this.db,
  ) {
    const price = await this.price(provider, model, executor);
    if (!price) return { amount: 0, currency: "USD", price: undefined };
    return {
      amount:
        (inputTokens * Number(price.input_per_million) +
          outputTokens * Number(price.output_per_million)) /
        1_000_000,
      currency: String(price.currency),
      price,
    };
  }
  async assertRunBudget(
    provider: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    limit?: number,
  ) {
    if (limit === undefined) return;
    const estimate = await this.estimate(
      provider,
      model,
      inputTokens,
      outputTokens,
    );
    if (estimate.amount > limit)
      throw new BudgetExceeded(
        `estimated run cost ${estimate.amount.toFixed(6)} ${estimate.currency} exceeds ${limit}`,
      );
  }
  async tenantSpend(tenantId: string, since: Date) {
    const row = (
      await this.db.query<{ amount: number }>(
        "SELECT COALESCE(sum(amount),0) amount FROM cost_records WHERE tenant_id=$1 AND created_at>=$2",
        [tenantId, since.toISOString()],
      )
    ).rows[0];
    return Number(row?.amount ?? 0);
  }
  async record(
    tx: SqlExecutor,
    input: {
      tenantId: string;
      runId: string;
      provider: string;
      model: string;
      requests: number;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      raw: unknown;
    },
  ) {
    const usage = await required<Record<string, unknown>>(
      tx,
      `INSERT INTO usage_records(id,tenant_id,run_id,model,provider,requests,input_tokens,output_tokens,total_tokens,raw_json)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) RETURNING *`,
      [
        newId(),
        input.tenantId,
        input.runId,
        input.model,
        input.provider,
        input.requests,
        input.inputTokens,
        input.outputTokens,
        input.totalTokens,
        JSON.stringify(input.raw),
      ],
    );
    const estimate = await this.estimate(
      input.provider,
      input.model,
      input.inputTokens,
      input.outputTokens,
      tx,
    );
    const cost = await required<Record<string, unknown>>(
      tx,
      `INSERT INTO cost_records(id,tenant_id,run_id,usage_record_id,price_id,amount,currency,calculation_json)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING *`,
      [
        newId(),
        input.tenantId,
        input.runId,
        usage.id,
        estimate.price?.id ?? null,
        estimate.amount,
        estimate.currency,
        JSON.stringify({
          input_tokens: input.inputTokens,
          output_tokens: input.outputTokens,
          price_version: estimate.price?.version ?? null,
        }),
      ],
    );
    return { usage, cost };
  }
  async usage(tenantId: string, runId?: string) {
    return (
      await this.db.query(
        `SELECT * FROM usage_records WHERE tenant_id=$1 ${runId ? "AND run_id=$2" : ""} ORDER BY created_at DESC`,
        runId ? [tenantId, runId] : [tenantId],
      )
    ).rows;
  }
  async costs(tenantId: string, runId?: string) {
    return (
      await this.db.query(
        `SELECT * FROM cost_records WHERE tenant_id=$1 ${runId ? "AND run_id=$2" : ""} ORDER BY created_at DESC`,
        runId ? [tenantId, runId] : [tenantId],
      )
    ).rows;
  }
}
