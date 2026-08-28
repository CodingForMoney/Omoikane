ALTER TABLE runs ADD COLUMN IF NOT EXISTS deployment_id TEXT;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS external_session_id TEXT;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS conversation_json JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS new_items_json JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS projection_json JSONB;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS usage_json JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS execution_expires_at TIMESTAMPTZ;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS payload_purged_at TIMESTAMPTZ;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS encrypted_payload BYTEA;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS payload_checksum TEXT;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS encrypted_result BYTEA;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS result_checksum TEXT;

UPDATE runs SET deployment_id=agent_version_id WHERE deployment_id IS NULL;
ALTER TABLE runs ALTER COLUMN deployment_id SET NOT NULL;

UPDATE resources
SET kind='agent_deployment', parent_id=NULL, status='active', updated_at=now()
WHERE kind='agent_version' AND status='published';

UPDATE resources
SET status='legacy', updated_at=now()
WHERE kind IN ('agent','agent_settings','agent_version','project_release','release_channel');

UPDATE artifacts
SET expires_at=COALESCE(expires_at,now()+interval '1 day')
WHERE status='active';

CREATE INDEX IF NOT EXISTS ix_runs_deployment ON runs(deployment_id,created_at);
CREATE INDEX IF NOT EXISTS ix_runs_payload_expiry ON runs(execution_expires_at,payload_purged_at);
CREATE INDEX IF NOT EXISTS ix_run_events_expiry ON run_events(created_at);
CREATE INDEX IF NOT EXISTS ix_artifacts_expiry ON artifacts(status,expires_at);
