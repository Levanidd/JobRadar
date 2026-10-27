-- The role without a place. Twins are candidates on this key, then kept only
-- when their cities actually overlap.

ALTER TABLE jobs ADD COLUMN role_key TEXT;

CREATE INDEX IF NOT EXISTS idx_jobs_role_key ON jobs(role_key);

CREATE TABLE IF NOT EXISTS dedup_released (
  job_id TEXT PRIMARY KEY
);
