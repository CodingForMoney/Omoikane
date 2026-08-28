DROP TABLE IF EXISTS webhook_deliveries CASCADE;
DROP TABLE IF EXISTS webhook_subscriptions CASCADE;
DROP TABLE IF EXISTS context_projections CASCADE;
DROP TABLE IF EXISTS compactions CASCADE;
DROP TABLE IF EXISTS memories CASCADE;
DROP TABLE IF EXISTS cost_records CASCADE;
DROP TABLE IF EXISTS price_catalog CASCADE;
DROP TABLE IF EXISTS audit_logs CASCADE;
DROP TABLE IF EXISTS session_items CASCADE;

DROP INDEX IF EXISTS ix_runs_session;
DROP INDEX IF EXISTS ix_runs_queue;
ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_tenant_id_idempotency_key_key;
ALTER TABLE runs DROP COLUMN IF EXISTS session_id;
ALTER TABLE runs DROP COLUMN IF EXISTS agent_version_id;
ALTER TABLE runs DROP COLUMN IF EXISTS runtime_generation;
ALTER TABLE runs DROP COLUMN IF EXISTS tenant_id;
CREATE INDEX IF NOT EXISTS ix_runs_queue ON runs(status,lease_expires_at,created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_runs_idempotency ON runs(idempotency_key) WHERE idempotency_key IS NOT NULL;

DROP TABLE IF EXISTS sessions CASCADE;

DROP INDEX IF EXISTS uq_resources_slug;
DROP INDEX IF EXISTS ix_resources_kind;
ALTER TABLE resources DROP COLUMN IF EXISTS tenant_id;
CREATE INDEX IF NOT EXISTS ix_resources_kind ON resources(kind,created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_resources_slug ON resources(kind,slug) WHERE slug IS NOT NULL;

ALTER TABLE run_events DROP COLUMN IF EXISTS published_at;
ALTER TABLE run_events DROP COLUMN IF EXISTS publish_attempts;
ALTER TABLE run_events DROP COLUMN IF EXISTS last_publish_error;
ALTER TABLE run_events DROP COLUMN IF EXISTS next_publish_at;
ALTER TABLE run_events DROP COLUMN IF EXISTS publish_lease_owner;
ALTER TABLE run_events DROP COLUMN IF EXISTS publish_lease_expires_at;
DROP INDEX IF EXISTS ix_run_events_outbox;

DROP INDEX IF EXISTS ix_approvals_status;
ALTER TABLE approvals DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE approvals DROP COLUMN IF EXISTS decided_by;
CREATE INDEX IF NOT EXISTS ix_approvals_status ON approvals(status,created_at);

ALTER TABLE tool_executions DROP CONSTRAINT IF EXISTS tool_executions_tenant_id_idempotency_key_key;
ALTER TABLE tool_executions DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE tool_executions DROP COLUMN IF EXISTS resolved_by;
CREATE UNIQUE INDEX IF NOT EXISTS uq_tool_executions_idempotency ON tool_executions(idempotency_key);

ALTER TABLE artifacts DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE usage_records DROP COLUMN IF EXISTS tenant_id;
