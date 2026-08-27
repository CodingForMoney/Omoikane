import {
  PGlite,
  type Transaction as PGliteTransaction,
} from "@electric-sql/pglite";
import pg from "pg";
import type { Settings } from "./config.js";

export interface QueryResult<
  T extends Record<string, unknown> = Record<string, unknown>,
> {
  rows: T[];
  rowCount: number;
}

export interface SqlExecutor {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<T>>;
}

class PGliteExecutor implements SqlExecutor {
  constructor(private readonly client: PGlite | PGliteTransaction) {}

  async query<T extends Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResult<T>> {
    const result = await this.client.query<T>(sql, params);
    return {
      rows: result.rows as T[],
      rowCount: result.affectedRows ?? result.rows.length,
    };
  }
}

class PgExecutor implements SqlExecutor {
  constructor(private readonly client: pg.Pool | pg.PoolClient) {}

  async query<T extends Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResult<T>> {
    const result = await this.client.query(sql, params);
    return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
  }
}

export class Database implements SqlExecutor {
  private constructor(
    private readonly pglite?: PGlite,
    private readonly pool?: pg.Pool,
  ) {}

  static async connect(
    settings: Pick<Settings, "databaseUrl">,
  ): Promise<Database> {
    if (settings.databaseUrl.startsWith("pglite://")) {
      const dataDir = settings.databaseUrl.slice("pglite://".length);
      const instance = new PGlite(
        dataDir === ":memory:" ? "memory://" : dataDir,
      );
      await instance.waitReady;
      return new Database(instance);
    }
    if (
      !settings.databaseUrl.startsWith("postgres://") &&
      !settings.databaseUrl.startsWith("postgresql://")
    ) {
      throw new Error(
        "AGENT_DATABASE_URL must use pglite://, postgres://, or postgresql://",
      );
    }
    const pool = new pg.Pool({
      connectionString: settings.databaseUrl,
      max: 20,
    });
    await pool.query("SELECT 1");
    return new Database(undefined, pool);
  }

  get embedded(): boolean {
    return this.pglite !== undefined;
  }

  async query<T extends Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResult<T>> {
    if (this.pglite)
      return new PGliteExecutor(this.pglite).query<T>(sql, params);
    if (this.pool) return new PgExecutor(this.pool).query<T>(sql, params);
    throw new Error("database is closed");
  }

  async transaction<T>(callback: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    if (this.pglite) {
      return this.pglite.transaction((tx) => callback(new PGliteExecutor(tx)));
    }
    if (!this.pool) throw new Error("database is closed");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await callback(new PgExecutor(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pglite?.close();
    await this.pool?.end();
  }
}

export async function one<T extends Record<string, unknown>>(
  db: SqlExecutor,
  sql: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  return (await db.query<T>(sql, params)).rows[0];
}

export async function required<T extends Record<string, unknown>>(
  db: SqlExecutor,
  sql: string,
  params: unknown[] = [],
  message = "resource not found",
): Promise<T> {
  const row = await one<T>(db, sql, params);
  if (!row) throw new NotFoundError(message);
  return row;
}

export class NotFoundError extends Error {}
export class ConflictError extends Error {}
export class ValidationError extends Error {}
