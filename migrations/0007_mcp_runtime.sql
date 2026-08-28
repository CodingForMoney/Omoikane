CREATE TABLE IF NOT EXISTS mcp_run_bindings (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  server_id TEXT NOT NULL REFERENCES resources(id) ON DELETE RESTRICT,
  server_slug TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  tools_json JSONB NOT NULL,
  policy_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(run_id,server_id)
);
CREATE INDEX IF NOT EXISTS ix_mcp_run_bindings_server ON mcp_run_bindings(server_id,created_at);

ALTER TABLE tool_executions ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'function';
ALTER TABLE tool_executions ADD COLUMN IF NOT EXISTS source_id TEXT;
ALTER TABLE tool_executions ADD COLUMN IF NOT EXISTS side_effecting BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tool_executions ADD COLUMN IF NOT EXISTS output_size BIGINT;
ALTER TABLE tool_executions ADD COLUMN IF NOT EXISTS output_sha256 TEXT;
