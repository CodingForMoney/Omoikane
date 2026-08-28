CREATE INDEX IF NOT EXISTS ix_artifacts_run_status_page
ON artifacts(run_id,status,created_at DESC,id DESC);
