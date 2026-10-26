-- Reads of jobs were planned through idx_jobs_duplicate_of, which walks every
-- primary row and pulls description overflow pages with it. These indexes
-- match the filters the list, the scorer, stats and the archive actually use.

CREATE INDEX IF NOT EXISTS idx_jobs_source_closed ON jobs(source_id, closed_at) WHERE closed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_source_seen ON jobs(source_id, closed_at, last_seen_at, duplicate_of);
CREATE INDEX IF NOT EXISTS idx_jobs_live ON jobs(first_seen_at) WHERE closed_at IS NULL AND duplicate_of IS NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_primary ON jobs(first_seen_at, closed_at) WHERE duplicate_of IS NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_open_company_name ON jobs(company_key, company) WHERE closed_at IS NULL;
