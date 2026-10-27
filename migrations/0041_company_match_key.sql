-- A looser company key for twin search and "you already applied" lookup.
-- company_key itself is unchanged.

ALTER TABLE jobs ADD COLUMN company_match_key TEXT;

CREATE INDEX IF NOT EXISTS idx_jobs_company_match ON jobs(company_match_key);
