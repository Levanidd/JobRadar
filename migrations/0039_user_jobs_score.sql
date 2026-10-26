-- The job list sorts by score. This index lets that page start from one user's
-- scored rows instead of every open posting.

CREATE INDEX IF NOT EXISTS idx_user_jobs_score ON user_jobs(user_id, score DESC, job_id);
