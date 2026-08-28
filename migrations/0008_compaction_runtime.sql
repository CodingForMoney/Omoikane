ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS compaction_state_json JSONB NOT NULL DEFAULT '{}'::jsonb;
