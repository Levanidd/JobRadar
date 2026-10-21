-- Search boards only return a fresh window. Rows they dropped were marked
-- closed the same day, which hid still-live postings from everyone but the
-- master. Ingest now keeps a search-board miss open for a month from
-- first_seen_at. This puts back the ones already closed inside that window.
-- Company boards are a full listing, so a miss there stays a takedown.

UPDATE jobs
SET closed_at = NULL
WHERE closed_at IS NOT NULL
  AND first_seen_at >= datetime('now', '-1 month')
  AND source_id IN (
    SELECT id FROM sources WHERE provider IN (
      '4dayweek', 'a16z-speedrun-talent', 'adzuna', 'amazon', 'arbeitnow',
      'arbeitsagentur', 'consider', 'flowxtra', 'generalist-world', 'getonbrd',
      'getro', 'hackernews', 'himalayas', 'jobicy', 'joinup', 'justjoin',
      'landingjobs', 'manfred', 'nodesk', 'nofluffjobs', 'remoteok', 'remotli',
      'remotive', 'startup-jobs', 'telegram-channel', 'thehub', 'weworkremotely',
      'workingnomads', 'wttj'
    )
  );
