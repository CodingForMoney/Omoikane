import { ValidationError } from "./database.js";

export interface PageOptions {
  limit?: number;
  cursor?: string;
}

export interface Page<T> {
  data: T[];
  next_cursor: string | null;
}

export interface PageCursor {
  createdAt: string;
  id: string;
}

interface EncodedCursor {
  v: 1;
  scope: string;
  created_at: string;
  id: string;
}

export const pageLimit = (value: number | undefined, maximum = 200) =>
  Math.min(Math.max(Math.trunc(value ?? 50), 1), maximum);

const isoDate = (value: Date | string) => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime()))
    throw new ValidationError("pagination row has an invalid created_at");
  return date.toISOString();
};

export function encodePageCursor(
  scope: string,
  row: { created_at: Date | string; id: string },
) {
  const value: EncodedCursor = {
    v: 1,
    scope,
    created_at: isoDate(row.created_at),
    id: String(row.id),
  };
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodePageCursor(
  value: string | undefined,
  expectedScope: string,
): PageCursor | undefined {
  if (!value) return undefined;
  try {
    if (value.length > 2048) throw new Error("cursor is too long");
    const decoded = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<EncodedCursor>;
    if (
      decoded.v !== 1 ||
      decoded.scope !== expectedScope ||
      typeof decoded.created_at !== "string" ||
      typeof decoded.id !== "string" ||
      !decoded.id ||
      !Number.isFinite(new Date(decoded.created_at).getTime())
    )
      throw new Error("cursor fields are invalid");
    return {
      createdAt: new Date(decoded.created_at).toISOString(),
      id: decoded.id,
    };
  } catch {
    throw new ValidationError("invalid or incompatible pagination cursor");
  }
}

export function pageFromRows<
  T extends { created_at: Date | string; id: string },
>(rows: T[], limit: number, scope: string): Page<T> {
  const data = rows.slice(0, limit);
  return {
    data,
    next_cursor:
      rows.length > limit && data.length
        ? encodePageCursor(scope, data[data.length - 1]!)
        : null,
  };
}
