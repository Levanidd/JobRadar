-- A board that takes an opening down and re-publishes it gives it a new id, and
-- by then our row for the old id is closed. Ingest used to look for twins among
-- open rows only, so the reposting landed as a brand-new vacancy and the person
-- who had already applied was shown it again. Ingest now merges the two; this
-- repairs the rows that slipped through, but only where someone acted on the
-- retired copy deliberately. Closed duplicates nobody touched are left alone.

INSERT INTO user_jobs (
  user_id, job_id, status, score, score_reason, flags, notes,
  applied_at, viewed_at, later_at, notified_at
)
SELECT uj.user_id, live.id, uj.status, uj.score, uj.score_reason, uj.flags, uj.notes,
       uj.applied_at, uj.viewed_at, uj.later_at, uj.notified_at
FROM user_jobs uj
JOIN jobs dead ON dead.id = uj.job_id
JOIN jobs live ON live.id = (
  SELECT l.id FROM jobs l
  WHERE l.dedup_key = dead.dedup_key AND l.closed_at IS NULL AND l.id <> dead.id
  ORDER BY l.last_seen_at DESC, l.id
  LIMIT 1
)
WHERE dead.closed_at IS NOT NULL
  AND dead.dedup_key IS NOT NULL
  AND (uj.applied_at IS NOT NULL OR uj.status IN ('applied', 'interview', 'rejected', 'saved', 'ignored'))
ON CONFLICT(user_id, job_id) DO UPDATE SET
  applied_at = COALESCE(user_jobs.applied_at, excluded.applied_at),
  viewed_at = COALESCE(user_jobs.viewed_at, excluded.viewed_at),
  later_at = COALESCE(user_jobs.later_at, excluded.later_at),
  notes = COALESCE(user_jobs.notes, excluded.notes),
  status = CASE WHEN excluded.status IN ('applied', 'interview', 'rejected', 'saved', 'ignored')
    THEN excluded.status ELSE user_jobs.status END,
  score = COALESCE(user_jobs.score, excluded.score),
  score_reason = COALESCE(user_jobs.score_reason, excluded.score_reason),
  flags = COALESCE(user_jobs.flags, excluded.flags),
  notified_at = COALESCE(user_jobs.notified_at, excluded.notified_at);

-- Leaving the retired copy behind would list the same application twice, since
-- Applied keys off applied_at and does not care whether the row is closed.
DELETE FROM jobs WHERE id IN (
  SELECT dead.id
  FROM user_jobs uj
  JOIN jobs dead ON dead.id = uj.job_id
  WHERE dead.closed_at IS NOT NULL
    AND dead.dedup_key IS NOT NULL
    AND (uj.applied_at IS NOT NULL OR uj.status IN ('applied', 'interview', 'rejected', 'saved', 'ignored'))
    AND EXISTS (
      SELECT 1 FROM jobs l
      WHERE l.dedup_key = dead.dedup_key AND l.closed_at IS NULL AND l.id <> dead.id
    )
);
