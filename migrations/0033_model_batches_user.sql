-- The monthly scoring limit sums one user's model calls on every scoring pass.
CREATE INDEX IF NOT EXISTS idx_model_batches_user ON model_batches(user_id, kind);
CREATE INDEX IF NOT EXISTS idx_model_requests_started ON model_requests(batch_id, started_at);
