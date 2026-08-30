CREATE TABLE IF NOT EXISTS mcp_oauth_states (
  server_id TEXT PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE,
  encrypted_state BYTEA NOT NULL,
  checksum TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

UPDATE resources
SET data=jsonb_set(data,'{auth}','{"type":"none"}'::jsonb,true)
WHERE kind='mcp_server' AND data->'auth' IS NULL;
