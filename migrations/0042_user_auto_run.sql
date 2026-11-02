-- Who gets their own prefilter and LLM score on a scheduled run.
-- Masters stay on, which is what a scheduled run already did.
ALTER TABLE users ADD COLUMN auto_run INTEGER NOT NULL DEFAULT 0;
UPDATE users SET auto_run = 1 WHERE role = 'master';
