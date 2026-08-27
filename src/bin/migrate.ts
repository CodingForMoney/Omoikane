#!/usr/bin/env node
import { Database } from "../database.js";
import { getSettings } from "../config.js";
import { migrate } from "../migrations.js";
const db = await Database.connect(getSettings());
try {
  const applied = await migrate(db);
  process.stdout.write(
    applied.length
      ? `Applied migrations: ${applied.join(", ")}\n`
      : "Database is current.\n",
  );
} finally {
  await db.close();
}
