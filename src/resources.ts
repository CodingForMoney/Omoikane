import type { Database, SqlExecutor } from "./database.js";
import { ConflictError, NotFoundError, required } from "./database.js";
import { newId } from "./serialization.js";

export interface Resource<
  T extends Record<string, unknown> = Record<string, unknown>,
> extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  kind: string;
  parent_id?: string;
  slug?: string;
  name?: string;
  status: string;
  created_at: string;
  updated_at: string;
  data: T;
}

interface ResourceRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  kind: string;
  parent_id: string | null;
  slug: string | null;
  name: string | null;
  status: string;
  data: Record<string, unknown>;
  created_at: Date | string;
  updated_at: Date | string;
}

export function publicResource<T extends Record<string, unknown>>(
  row: ResourceRow,
): Resource<T> & T {
  const resource = {
    id: row.id,
    tenant_id: row.tenant_id,
    kind: row.kind,
    ...(row.parent_id ? { parent_id: row.parent_id } : {}),
    ...(row.slug ? { slug: row.slug } : {}),
    ...(row.name ? { name: row.name } : {}),
    status: row.status,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
    data: row.data as T,
    ...(row.data as T),
  };
  return resource;
}

export class ResourceStore {
  constructor(private readonly db: Database) {}

  async create<T extends Record<string, unknown>>(
    options: {
      tenantId: string;
      kind: string;
      parentId?: string;
      slug?: string;
      name?: string;
      status?: string;
      data: T;
      id?: string;
    },
    executor: SqlExecutor = this.db,
  ): Promise<Resource<T> & T> {
    const id = options.id ?? newId();
    try {
      const row = await required<ResourceRow>(
        executor,
        `
        INSERT INTO resources(id, tenant_id, kind, parent_id, slug, name, status, data)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
        RETURNING *`,
        [
          id,
          options.tenantId,
          options.kind,
          options.parentId ?? null,
          options.slug ?? null,
          options.name ?? null,
          options.status ?? "active",
          JSON.stringify(options.data),
        ],
      );
      return publicResource<T>(row);
    } catch (error) {
      if (
        String(error).includes("unique") ||
        String(error).includes("duplicate")
      ) {
        throw new ConflictError(`${options.kind} already exists`);
      }
      throw error;
    }
  }

  async get<T extends Record<string, unknown>>(
    tenantId: string,
    kind: string,
    id: string,
    executor: SqlExecutor = this.db,
  ): Promise<Resource<T> & T> {
    const row = await required<ResourceRow>(
      executor,
      "SELECT * FROM resources WHERE id=$1 AND tenant_id=$2 AND kind=$3",
      [id, tenantId, kind],
      `${kind} not found`,
    );
    return publicResource<T>(row);
  }

  async findBySlug<T extends Record<string, unknown>>(
    tenantId: string,
    kind: string,
    slug: string,
  ): Promise<(Resource<T> & T) | undefined> {
    const rows = await this.db.query<ResourceRow>(
      "SELECT * FROM resources WHERE tenant_id=$1 AND kind=$2 AND slug=$3",
      [tenantId, kind, slug],
    );
    return rows.rows[0] ? publicResource<T>(rows.rows[0]) : undefined;
  }

  async list<T extends Record<string, unknown>>(
    tenantId: string,
    kind: string,
    options: { parentId?: string; status?: string; limit?: number } = {},
  ): Promise<Array<Resource<T> & T>> {
    const conditions = ["tenant_id=$1", "kind=$2"];
    const params: unknown[] = [tenantId, kind];
    if (options.parentId) {
      params.push(options.parentId);
      conditions.push(`parent_id=$${params.length}`);
    }
    if (options.status) {
      params.push(options.status);
      conditions.push(`status=$${params.length}`);
    }
    params.push(Math.min(options.limit ?? 500, 2000));
    const rows = await this.db.query<ResourceRow>(
      `SELECT * FROM resources WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    );
    return rows.rows.map((row) => publicResource<T>(row));
  }

  async update<T extends Record<string, unknown>>(
    tenantId: string,
    kind: string,
    id: string,
    patch: Partial<{
      slug: string;
      name: string;
      status: string;
      data: Partial<T>;
    }>,
    executor: SqlExecutor = this.db,
  ): Promise<Resource<T> & T> {
    const current = await this.get<T>(tenantId, kind, id, executor);
    const data = { ...current.data, ...(patch.data ?? {}) };
    const row = await required<ResourceRow>(
      executor,
      `
      UPDATE resources SET slug=$4, name=$5, status=$6, data=$7::jsonb, updated_at=now()
      WHERE id=$1 AND tenant_id=$2 AND kind=$3 RETURNING *`,
      [
        id,
        tenantId,
        kind,
        patch.slug ?? current.slug ?? null,
        patch.name ?? current.name ?? null,
        patch.status ?? current.status,
        JSON.stringify(data),
      ],
    );
    return publicResource<T>(row);
  }

  async delete(tenantId: string, kind: string, id: string): Promise<void> {
    const result = await this.db.query(
      "DELETE FROM resources WHERE id=$1 AND tenant_id=$2 AND kind=$3",
      [id, tenantId, kind],
    );
    if (result.rowCount === 0) throw new NotFoundError(`${kind} not found`);
  }
}
