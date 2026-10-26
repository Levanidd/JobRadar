-- A scoring hop can run longer than a minute. Without a claim, a second walker
-- started by the cron picks the same still-unscored rows and pays the model again.

ALTER TABLE user_jobs ADD COLUMN scoring_claimed_at TEXT;
ALTER TABLE user_jobs ADD COLUMN scoring_claim_id TEXT;
ALTER TABLE user_jobs ADD COLUMN scoring_attempts INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_user_jobs_claim
  ON user_jobs(user_id, scoring_claim_id)
  WHERE scoring_claim_id IS NOT NULL;

-- Auto scoring only looks at postings newer than this many days. 0 is not used;
-- the default of 14 is what a profile without an override gets in code too.
ALTER TABLE user_profiles ADD COLUMN score_window_days INTEGER NOT NULL DEFAULT 14;

ALTER TABLE cycles ADD COLUMN failed_scoring INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cycle_runs ADD COLUMN failed_scoring INTEGER NOT NULL DEFAULT 0;
