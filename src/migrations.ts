import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { Database } from "./database.js";

const migrations = ["0001_typescript_runtime.sql"] as const;

export async function migrate(database: Database): Promise<string[]> {
  await database.query(`CREATE TABLE IF NOT EXISTS omoikane_migrations (
    version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const applied = new Set(
    (
      await database.query<{ version: string }>(
        "SELECT version FROM omoikane_migrations",
      )
    ).rows.map((row) => row.version),
  );
  const completed: string[] = [];
  const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  for (const filename of migrations) {
    const version = filename.split("_")[0]!;
    if (applied.has(version)) continue;
    const path = resolve(packageRoot, "migrations", filename);
    const sql = await readFile(path, "utf8");
    await database.transaction(async (tx) => {
      for (const statement of sql.split(/;\s*(?:\n|$)/)) {
        if (statement.trim()) await tx.query(statement);
      }
      await tx.query("INSERT INTO omoikane_migrations(version) VALUES ($1)", [
        version,
      ]);
    });
    completed.push(version);
  }
  return completed;
}
