CREATE TABLE IF NOT EXISTS omoikane_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS resources (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  kind TEXT NOT NULL,
  parent_id TEXT,
  slug TEXT,
  name TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_resources_kind ON resources(tenant_id, kind, created_at);
CREATE INDEX IF NOT EXISTS ix_resources_parent ON resources(parent_id, kind);
CREATE UNIQUE INDEX IF NOT EXISTS uq_resources_slug
  ON resources(tenant_id, kind, slug) WHERE slug IS NOT NULL;

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  status TEXT NOT NULL DEFAULT 'active',
  scope JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_item_seq INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0,
  active_projection_revision INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_sessions_tenant ON sessions(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS session_items (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  item_json JSONB NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(session_id, seq)
);
CREATE INDEX IF NOT EXISTS ix_session_items_active ON session_items(session_id, active, seq);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  agent_version_id TEXT NOT NULL,
  session_id TEXT REFERENCES sessions(id),
  parent_run_id TEXT REFERENCES runs(id),
  status TEXT NOT NULL DEFAULT 'queued',
  input_json JSONB NOT NULL,
  output_json JSONB,
  error_json JSONB,
  limits_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  context_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key TEXT,
  sdk_version TEXT NOT NULL,
  runtime_generation TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS ix_runs_queue ON runs(status, runtime_generation, lease_expires_at, created_at);
CREATE INDEX IF NOT EXISTS ix_runs_session ON runs(session_id, created_at);

CREATE TABLE IF NOT EXISTS run_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  trace_id TEXT,
  published_at TIMESTAMPTZ,
  publish_attempts INTEGER NOT NULL DEFAULT 0,
  last_publish_error TEXT,
  next_publish_at TIMESTAMPTZ,
  publish_lease_owner TEXT,
  publish_lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(run_id, seq)
);
CREATE INDEX IF NOT EXISTS ix_run_events_lookup ON run_events(run_id, seq);
CREATE INDEX IF NOT EXISTS ix_run_events_outbox ON run_events(published_at, next_publish_at, created_at);

CREATE TABLE IF NOT EXISTS run_states (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  format_version DOUBLE PRECISION NOT NULL,
  sdk_version TEXT NOT NULL,
  encrypted_state BYTEA NOT NULL,
  checksum TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  interruption_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  request_json JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  decided_by TEXT,
  decision_reason TEXT,
  decided_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(run_id, interruption_id)
);
CREATE INDEX IF NOT EXISTS ix_approvals_status ON approvals(tenant_id, status, created_at);

CREATE TABLE IF NOT EXISTS tool_executions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  implementation_key TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  arguments_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  attempt_count INTEGER NOT NULL DEFAULT 1,
  output_json JSONB,
  error_json JSONB,
  lease_expires_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  resolved_by TEXT,
  resolution_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS ix_tool_executions_run ON tool_executions(run_id, status, created_at);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'semantic',
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  embedding_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to TIMESTAMPTZ,
  superseded_by TEXT,
  source_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_memories_scope ON memories(tenant_id, scope_type, scope_id, enabled);

CREATE TABLE IF NOT EXISTS compactions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id),
  status TEXT NOT NULL DEFAULT 'pending',
  strategy TEXT NOT NULL DEFAULT 'portable',
  trigger TEXT NOT NULL DEFAULT 'manual',
  source_from_seq INTEGER NOT NULL,
  source_to_seq INTEGER NOT NULL,
  source_revision INTEGER NOT NULL,
  summary_item_id TEXT,
  summary_text TEXT NOT NULL DEFAULT '',
  summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  native_items_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  metrics_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  validation_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  tokens_before INTEGER NOT NULL DEFAULT 0,
  tokens_after INTEGER NOT NULL DEFAULT 0,
  compression_ratio DOUBLE PRECISION NOT NULL DEFAULT 0,
  failure_reason TEXT,
  attempt_id TEXT NOT NULL,
  engine_name TEXT NOT NULL DEFAULT 'portable',
  engine_version TEXT NOT NULL DEFAULT '3',
  parent_compaction_id TEXT REFERENCES compactions(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_compactions_session ON compactions(session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS context_projections (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  compaction_id TEXT NOT NULL UNIQUE REFERENCES compactions(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  source_from_seq INTEGER NOT NULL,
  source_to_seq INTEGER NOT NULL,
  source_revision INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  strategy TEXT NOT NULL,
  tokens INTEGER NOT NULL DEFAULT 0,
  checksum TEXT NOT NULL,
  segments_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(session_id, revision)
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  run_id TEXT REFERENCES runs(id),
  source TEXT NOT NULL DEFAULT 'upload',
  filename TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size BIGINT NOT NULL,
  lineage_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'active',
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_artifacts_run ON artifacts(run_id, created_at);

CREATE TABLE IF NOT EXISTS usage_records (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  raw_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS price_catalog (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  version TEXT NOT NULL,
  input_per_million DOUBLE PRECISION NOT NULL,
  output_per_million DOUBLE PRECISION NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  effective_from TIMESTAMPTZ NOT NULL,
  effective_to TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cost_records (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  usage_record_id TEXT NOT NULL REFERENCES usage_records(id),
  price_id TEXT REFERENCES price_catalog(id),
  amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  calculation_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  event_types_json JSONB NOT NULL DEFAULT '["*"]'::jsonb,
  secret_ciphertext BYTEA NOT NULL,
  secret_checksum TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  max_attempts INTEGER NOT NULL DEFAULT 10,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, name)
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subscription_id TEXT NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES run_events(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  response_status INTEGER,
  last_error TEXT,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(subscription_id, event_id)
);
CREATE INDEX IF NOT EXISTS ix_webhook_deliveries_pending
  ON webhook_deliveries(status, next_attempt_at, created_at);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  actor_id TEXT NOT NULL DEFAULT 'system',
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  before_json JSONB,
  after_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_audit_resource ON audit_logs(resource_type, resource_id);
