import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (
      item &&
      typeof item === "object" &&
      !(item instanceof Date) &&
      !Buffer.isBuffer(item)
    ) {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, sort(child)]),
      );
    }
    if (item instanceof Date) return item.toISOString();
    if (Buffer.isBuffer(item)) return item.toString("base64");
    return item;
  };
  return JSON.stringify(sort(value));
}

export const hashJson = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

export const newId = (): string => crypto.randomUUID();
export const nowIso = (): string => new Date().toISOString();
