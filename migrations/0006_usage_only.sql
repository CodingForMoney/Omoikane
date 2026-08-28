ALTER TABLE usage_records ADD COLUMN IF NOT EXISTS reporting_status TEXT;

UPDATE usage_records
SET reporting_status = CASE
  WHEN input_tokens = 0 AND output_tokens = 0 AND total_tokens = 0 THEN 'missing'
  WHEN total_tokens <> input_tokens + output_tokens THEN 'partial'
  ELSE 'reported'
END
WHERE reporting_status IS NULL;

ALTER TABLE usage_records ALTER COLUMN reporting_status SET DEFAULT 'missing';
ALTER TABLE usage_records ALTER COLUMN reporting_status SET NOT NULL;

ALTER TABLE usage_records ALTER COLUMN input_tokens DROP DEFAULT;
ALTER TABLE usage_records ALTER COLUMN output_tokens DROP DEFAULT;
ALTER TABLE usage_records ALTER COLUMN total_tokens DROP DEFAULT;
ALTER TABLE usage_records ALTER COLUMN input_tokens DROP NOT NULL;
ALTER TABLE usage_records ALTER COLUMN output_tokens DROP NOT NULL;
ALTER TABLE usage_records ALTER COLUMN total_tokens DROP NOT NULL;

UPDATE usage_records
SET input_tokens = NULL, output_tokens = NULL, total_tokens = NULL
WHERE reporting_status = 'missing';

DELETE FROM usage_records
WHERE id NOT IN (
  SELECT DISTINCT ON (run_id) id
  FROM usage_records
  ORDER BY run_id, created_at DESC
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_usage_records_run ON usage_records(run_id);
