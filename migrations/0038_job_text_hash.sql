-- A short digest of the body already stored in job_texts. Ingest compares this
-- instead of reading the text, and skips the write when the board sent the same body.

ALTER TABLE jobs ADD COLUMN text_hash TEXT;
