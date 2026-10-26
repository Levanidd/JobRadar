-- Covering indexes so the job list and the stats totals never open a jobs row.
-- Built after descriptions moved out, so creating them does not pull the old overflow pages.

CREATE INDEX IF NOT EXISTS idx_jobs_list_cover
  ON jobs(first_seen_at, id, source_id, company_key, closed_at, duplicate_of)
  WHERE closed_at IS NULL AND duplicate_of IS NULL;

CREATE INDEX IF NOT EXISTS idx_user_jobs_list
  ON user_jobs(user_id, job_id, score, status);

CREATE INDEX IF NOT EXISTS idx_jobs_stat_cover
  ON jobs(id, company_key, closed_at, duplicate_of)
  WHERE duplicate_of IS NULL;

CREATE INDEX IF NOT EXISTS idx_user_jobs_stat
  ON user_jobs(user_id, job_id, viewed_at, applied_at, later_at);
