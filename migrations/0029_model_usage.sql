-- Every call to the model, with its timing and token counts, grouped into the
-- batch that issued it: one scoring pass of a cycle for one user, a manual
-- rescore, a single-job score, or a model check from settings.
CREATE TABLE model_batches (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL,
  run_id        INTEGER REFERENCES cycle_runs(id),
  user_id       INTEGER REFERENCES users(id),
  trigger       TEXT NOT NULL CHECK (trigger IN ('manual', 'auto')),
  model         TEXT,
  started_at    TEXT NOT NULL,
  finished_at   TEXT NOT NULL,
  requests      INTEGER NOT NULL DEFAULT 0,
  jobs          INTEGER NOT NULL DEFAULT 0,
  failed        INTEGER NOT NULL DEFAULT 0,
  duration_ms   INTEGER NOT NULL DEFAULT 0,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_model_batches_run ON model_batches(run_id, user_id);

CREATE TABLE model_requests (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id       INTEGER NOT NULL REFERENCES model_batches(id),
  model          TEXT NOT NULL,
  started_at     TEXT NOT NULL,
  finished_at    TEXT NOT NULL,
  duration_ms    INTEGER NOT NULL,
  jobs           INTEGER NOT NULL,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  thought_tokens INTEGER NOT NULL DEFAULT 0,
  ok             INTEGER NOT NULL,
  error          TEXT
);

CREATE INDEX idx_model_requests_batch ON model_requests(batch_id);
