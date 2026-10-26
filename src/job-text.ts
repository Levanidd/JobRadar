import { placeholders, runBatch, selectIn } from "./db"
import type { Bindings } from "./types"

/** Joined wherever a query still has to show or score the posting body. */
export const JOB_TEXT_JOIN = `LEFT JOIN job_texts t ON t.job_id = j.id`

/**
 * Body as readers see it. job_texts wins. The jobs column is only consulted
 * when that row has not been copied yet, and SQLite stops before reading it
 * once job_texts has the text.
 */
export const JOB_DESCRIPTION = `CASE WHEN t.description IS NOT NULL THEN t.description ELSE j.description END`

/** 1 when neither copy has a body. */
export const NO_TEXT = `CASE WHEN t.description IS NOT NULL THEN 0 WHEN j.description IS NOT NULL THEN 0 ELSE 1 END`

/** 1 when either copy has a body. */
export const HAS_TEXT = `CASE WHEN t.description IS NOT NULL THEN 1 WHEN j.description IS NOT NULL THEN 1 ELSE 0 END`

/** Writes the body. A later empty fetch must not wipe a body we already kept. */
export function saveJobText(env: Bindings, jobId: string, description: string) {
  return env.DB.prepare(
    `INSERT INTO job_texts (job_id, description) VALUES (?, ?)
     ON CONFLICT(job_id) DO UPDATE SET
       description = COALESCE(excluded.description, job_texts.description),
       updated_at = datetime('now')`,
  ).bind(jobId, description)
}

/**
 * Fills a body only when we don't have one yet. A detail fetch must not
 * replace text the board already sent.
 */
export function saveJobTextIfEmpty(env: Bindings, jobId: string, description: string) {
  return env.DB.prepare(
    `INSERT INTO job_texts (job_id, description) VALUES (?, ?)
     ON CONFLICT(job_id) DO UPDATE SET
       description = excluded.description,
       updated_at = datetime('now')
     WHERE job_texts.description IS NULL`,
  ).bind(jobId, description)
}

export function deleteJobTexts(env: Bindings, ids: string[]) {
  return env.DB.prepare(`DELETE FROM job_texts WHERE job_id IN (${placeholders(ids.length)})`).bind(...ids)
}

/**
 * Copies bodies out of jobs.description in rowid order and then clears them.
 * Repeating a call is safe: a body already stored is left as it is, and a
 * cleared jobs.description is not selected again. Returns 0 when nothing remains.
 */
export async function backfillJobTexts(
  env: Bindings,
  after: number,
  limit: number,
): Promise<{ after: number; moved: number }> {
  const size = Math.min(200, Math.max(1, Math.floor(limit)))
  const picked = await env.DB.prepare(
    `SELECT rowid AS rid, id, description
     FROM jobs
     WHERE description IS NOT NULL AND rowid > ?
     ORDER BY rowid
     LIMIT ?`,
  )
    .bind(after, size)
    .all<{ rid: number; id: string; description: string }>()
  const rows = picked.results
  if (rows.length === 0) return { after: 0, moved: 0 }

  const already = new Set(
    (
      await selectIn<{ job_id: string }>(
        env,
        (list) => `SELECT job_id FROM job_texts WHERE job_id IN (${list}) AND description IS NOT NULL`,
        rows.map((row) => row.id),
      )
    ).map((row) => row.job_id),
  )

  await runBatch(
    env,
    rows.map((row) =>
      env.DB.prepare(`INSERT OR IGNORE INTO job_texts (job_id, description) VALUES (?, ?)`).bind(row.id, row.description),
    ),
  )

  const stored = await selectIn<{ job_id: string; description: string | null }>(
    env,
    (list) => `SELECT job_id, description FROM job_texts WHERE job_id IN (${list})`,
    rows.map((row) => row.id),
  )
  const byId = new Map(stored.map((row) => [row.job_id, row.description]))
  for (const row of rows) {
    const kept = byId.get(row.id)
    if (kept == null) throw new Error(`job_texts missed ${row.id}`)
    // A body written by ingest while this batch was running stays. Everything
    // we just copied has to match the jobs row we read.
    if (!already.has(row.id) && kept !== row.description) throw new Error(`job_texts mismatch for ${row.id}`)
  }

  await env.DB.prepare(
    `UPDATE jobs SET description = NULL
     WHERE rowid IN (${placeholders(rows.length)})
       AND id IN (SELECT job_id FROM job_texts WHERE description IS NOT NULL)`,
  )
    .bind(...rows.map((row) => row.rid))
    .run()

  return { after: rows[rows.length - 1]!.rid, moved: rows.length }
}
