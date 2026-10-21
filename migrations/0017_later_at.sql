-- "Look at later" is a mark on a posting, not a stage it moves through, so
-- it gets a column of its own instead of another value in status: a job put
-- aside for later keeps whatever the machine already knew about it and still
-- reaches the digest.
ALTER TABLE jobs ADD COLUMN later_at TEXT;
CREATE INDEX IF NOT EXISTS idx_jobs_later ON jobs(later_at) WHERE later_at IS NOT NULL;
