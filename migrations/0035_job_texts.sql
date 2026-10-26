-- The posting body used to sit in jobs ahead of the columns every list reads,
-- so a row wider than a page pulled the text along with the dates. The body
-- now lives here. jobs.description stays, empty, until a later migration can
-- afford to rebuild the table.

CREATE TABLE IF NOT EXISTS job_texts (
  job_id TEXT PRIMARY KEY,
  description TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
