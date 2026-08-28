#!/usr/bin/env node
import { getSettings } from "../config.js";
import { safeUpgrade } from "../upgrade.js";
const settings = getSettings();
const result = await safeUpgrade(settings);
process.stdout.write(
  `${JSON.stringify(
    {
      ...result,
      backup: result.backup
        ? {
            path: result.backup.path,
            format: `${result.backup.manifest.format}/v${result.backup.manifest.format_version}`,
            created_at: result.backup.manifest.created_at,
            migration_version: result.backup.manifest.migration.current_version,
            files_verified: result.backup.files_verified,
            bytes_verified: result.backup.bytes_verified,
          }
        : undefined,
    },
    null,
    2,
  )}\n`,
);
