import type { Database, SqlExecutor } from "./database.js";
import { ConflictError, NotFoundError, required } from "./database.js";
import { newId } from "./serialization.js";
import {
  decodePageCursor,
  pageFromRows,
  pageLimit,
  type Page,
  type PageOptions,
} from "./pagination.js";

export interface Resource<
  T extends Record<string, unknown> = Record<string, unknown>,
> extends Record<string, unknown> {
  id: string;
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
        INSERT INTO resources(id, kind, parent_id, slug, name, status, data)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
        RETURNING *`,
        [
          id,
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
    kind: string,
    id: string,
    executor: SqlExecutor = this.db,
  ): Promise<Resource<T> & T> {
    const row = await required<ResourceRow>(
      executor,
      "SELECT * FROM resources WHERE id=$1 AND kind=$2",
      [id, kind],
      `${kind} not found`,
    );
    return publicResource<T>(row);
  }

  async findBySlug<T extends Record<string, unknown>>(
    kind: string,
    slug: string,
    executor: SqlExecutor = this.db,
  ): Promise<(Resource<T> & T) | undefined> {
    const rows = await executor.query<ResourceRow>(
      "SELECT * FROM resources WHERE kind=$1 AND slug=$2",
      [kind, slug],
    );
    return rows.rows[0] ? publicResource<T>(rows.rows[0]) : undefined;
  }

  async list<T extends Record<string, unknown>>(
    kind: string,
    options: { parentId?: string; status?: string; limit?: number } = {},
    executor: SqlExecutor = this.db,
  ): Promise<Array<Resource<T> & T>> {
    const conditions = ["kind=$1"];
    const params: unknown[] = [kind];
    if (options.parentId) {
      params.push(options.parentId);
      conditions.push(`parent_id=$${params.length}`);
    }
    if (options.status) {
      params.push(options.status);
      conditions.push(`status=$${params.length}`);
    }
    params.push(Math.min(options.limit ?? 500, 2000));
    const rows = await executor.query<ResourceRow>(
      `SELECT * FROM resources WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    );
    return rows.rows.map((row) => publicResource<T>(row));
  }

  async page<T extends Record<string, unknown>>(
    kind: string,
    options: PageOptions & { parentId?: string; status?: string } = {},
    executor: SqlExecutor = this.db,
  ): Promise<Page<Resource<T> & T>> {
    const limit = pageLimit(options.limit);
    const scope = JSON.stringify([
      "resources",
      kind,
      options.parentId ?? null,
      options.status ?? null,
    ]);
    const cursor = decodePageCursor(options.cursor, scope);
    const conditions = ["kind=$1"];
    const params: unknown[] = [kind];
    if (options.parentId) {
      params.push(options.parentId);
      conditions.push(`parent_id=$${params.length}`);
    }
    if (options.status) {
      params.push(options.status);
      conditions.push(`status=$${params.length}`);
    }
    if (cursor) {
      params.push(cursor.createdAt);
      const createdAtParameter = params.length;
      params.push(cursor.id);
      conditions.push(
        `(created_at<$${createdAtParameter} OR (created_at=$${createdAtParameter} AND id<$${params.length}))`,
      );
    }
    params.push(limit + 1);
    const rows = await executor.query<ResourceRow>(
      `SELECT * FROM resources WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC,id DESC LIMIT $${params.length}`,
      params,
    );
    const page = pageFromRows(rows.rows, limit, scope);
    return { ...page, data: page.data.map((row) => publicResource<T>(row)) };
  }

  async update<T extends Record<string, unknown>>(
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
    const current = await this.get<T>(kind, id, executor);
    const data = { ...current.data, ...(patch.data ?? {}) };
    const row = await required<ResourceRow>(
      executor,
      `
      UPDATE resources SET slug=$3, name=$4, status=$5, data=$6::jsonb, updated_at=now()
      WHERE id=$1 AND kind=$2 RETURNING *`,
      [
        id,
        kind,
        patch.slug ?? current.slug ?? null,
        patch.name ?? current.name ?? null,
        patch.status ?? current.status,
        JSON.stringify(data),
      ],
    );
    return publicResource<T>(row);
  }

  async delete(kind: string, id: string): Promise<void> {
    const result = await this.db.query(
      "DELETE FROM resources WHERE id=$1 AND kind=$2",
      [id, kind],
    );
    if (result.rowCount === 0) throw new NotFoundError(`${kind} not found`);
  }
}
