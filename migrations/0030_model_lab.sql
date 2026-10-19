-- Model Lab: a master replays already-scored postings through several models,
-- a few times each, and compares the answers with the stored score. It only
-- reads production tables; everything it produces lives here.
CREATE TABLE lab_runs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL,
  created_by       INTEGER NOT NULL REFERENCES users(id),
  user_id          INTEGER NOT NULL REFERENCES users(id),
  status           TEXT NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued', 'running', 'done', 'error', 'cancelled')),
  sample_mode      TEXT NOT NULL CHECK (sample_mode IN ('random', 'stratified')),
  include_labeled  INTEGER NOT NULL DEFAULT 1,
  sample_size      INTEGER NOT NULL,
  repeats          INTEGER NOT NULL,
  seed             INTEGER NOT NULL,
  cloned_from      INTEGER REFERENCES lab_runs(id) ON DELETE SET NULL,
  profile_snapshot TEXT NOT NULL,
  system_prompt    TEXT NOT NULL,
  prompt_hash      TEXT NOT NULL,
  -- The production model when the run was created: the likely, not certain, author of the baseline.
  baseline_model   TEXT,
  -- Every call of the run lands in this one model_batches row.
  usage_batch_id   INTEGER REFERENCES model_batches(id),
  total            INTEGER NOT NULL DEFAULT 0,
  done             INTEGER NOT NULL DEFAULT 0,
  failed           INTEGER NOT NULL DEFAULT 0,
  hops             INTEGER NOT NULL DEFAULT 0,
  error            TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  started_at       TEXT,
  updated_at       TEXT,
  finished_at      TEXT
);

CREATE TABLE lab_candidates (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  lab_run_id      INTEGER NOT NULL REFERENCES lab_runs(id) ON DELETE CASCADE,
  position        INTEGER NOT NULL,
  provider        TEXT NOT NULL CHECK (provider IN ('gemini', 'nebius')),
  model           TEXT NOT NULL,
  thinking_level  TEXT,
  price_in_per_m  REAL,
  price_out_per_m REAL,
  UNIQUE (lab_run_id, provider, model, thinking_level)
);

-- No FK on job_id: dedup may delete the posting, and the snapshot has to outlive it.
CREATE TABLE lab_jobs (
  lab_run_id      INTEGER NOT NULL REFERENCES lab_runs(id) ON DELETE CASCADE,
  job_id          TEXT NOT NULL,
  position        INTEGER NOT NULL,
  stratum         TEXT,
  title           TEXT NOT NULL,
  company         TEXT NOT NULL,
  location        TEXT,
  url             TEXT,
  description     TEXT NOT NULL,
  baseline_score  INTEGER,
  baseline_reason TEXT,
  baseline_flags  TEXT,
  baseline_status TEXT,
  PRIMARY KEY (lab_run_id, job_id)
);

CREATE TABLE lab_trials (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  lab_run_id     INTEGER NOT NULL REFERENCES lab_runs(id) ON DELETE CASCADE,
  candidate_id   INTEGER NOT NULL REFERENCES lab_candidates(id) ON DELETE CASCADE,
  job_id         TEXT NOT NULL,
  repeat_no      INTEGER NOT NULL,
  exec_order     INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'running', 'ok', 'failed', 'cancelled')),
  score          INTEGER,
  reason         TEXT,
  flags          TEXT,
  raw_response   TEXT,
  error_code     TEXT,
  error          TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0,
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  thought_tokens INTEGER,
  duration_ms    INTEGER,
  claimed_at     TEXT,
  finished_at    TEXT,
  UNIQUE (lab_run_id, candidate_id, job_id, repeat_no)
);

CREATE INDEX lab_trials_queue ON lab_trials (lab_run_id, status, exec_order);
