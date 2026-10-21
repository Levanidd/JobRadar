-- Closed search-board postings with no application, note, Claude comment, or
-- CV leave the live tables and land here. The rows stay queryable, but twin
-- matching and the job list no longer walk them. No foreign keys: the archive
-- has to outlive the source and the user it was copied from.

CREATE TABLE archive_jobs (
  id              TEXT PRIMARY KEY,
  source_id       INTEGER,
  source_provider TEXT,
  source_label    TEXT,
  source_kind     TEXT,
  external_id     TEXT NOT NULL,
  company         TEXT NOT NULL,
  company_key     TEXT NOT NULL,
  title           TEXT NOT NULL,
  location        TEXT,
  url             TEXT NOT NULL,
  description     TEXT,
  posted_at       TEXT,
  first_seen_at   TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL,
  closed_at       TEXT,
  changed_at      TEXT,
  dedup_key       TEXT,
  duplicate_of    TEXT,
  status          TEXT NOT NULL,
  score           INTEGER,
  score_reason    TEXT,
  flags           TEXT,
  notified_at     TEXT,
  notes           TEXT,
  applied_at      TEXT,
  viewed_at       TEXT,
  later_at        TEXT,
  salary_min      INTEGER,
  salary_max      INTEGER,
  salary_currency TEXT,
  archived_at     TEXT NOT NULL
);
CREATE INDEX idx_archive_jobs_company ON archive_jobs(company_key);
CREATE INDEX idx_archive_jobs_closed ON archive_jobs(closed_at);

CREATE TABLE archive_user_jobs (
  user_id        INTEGER NOT NULL,
  job_id         TEXT NOT NULL,
  status         TEXT NOT NULL,
  score          INTEGER,
  score_reason   TEXT,
  flags          TEXT,
  notes          TEXT,
  applied_at     TEXT,
  viewed_at      TEXT,
  later_at       TEXT,
  notified_at    TEXT,
  interviewed_at TEXT,
  cv_url         TEXT,
  claude_comment TEXT,
  archived_at    TEXT NOT NULL,
  PRIMARY KEY (user_id, job_id)
);
CREATE INDEX idx_archive_user_jobs_job ON archive_user_jobs(job_id);

CREATE TABLE archive_interview_stages (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  job_id      TEXT NOT NULL,
  title       TEXT NOT NULL,
  happened_on TEXT,
  created_at  TEXT NOT NULL,
  archived_at TEXT NOT NULL
);
CREATE INDEX idx_archive_interview_stages_job ON archive_interview_stages(job_id);
