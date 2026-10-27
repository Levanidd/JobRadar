import { dedupKey, roleKey } from "./company-key"
import { runBatch } from "./db"
import type { Bindings } from "./types"

type OpenJob = {
  rid: number
  id: string
  company: string
  title: string
  location: string | null
  dedup_key: string | null
  role_key: string | null
}

type LinkedJob = OpenJob & {
  parent_company: string
  parent_title: string
  parent_location: string | null
}

const RESET_SCORE = `UPDATE user_jobs SET score = NULL, score_reason = NULL, flags = NULL
  WHERE job_id = ?
    AND applied_at IS NULL AND interviewed_at IS NULL
    AND TRIM(COALESCE(notes, '')) = ''
    AND TRIM(COALESCE(cv_url, '')) = ''
    AND TRIM(COALESCE(claude_comment, '')) = ''
    AND COALESCE(status, 'new') IN ('new', 'off_profile')`

/**
 * Rewrites dedup_key on open jobs from company, title and location.
 * Repeating a call is safe: a key that already matches is left alone.
 */
export async function rekeyDedupBatch(
  env: Bindings,
  after: number,
  limit: number,
): Promise<{ after: number; updated: number }> {
  const size = Math.min(200, Math.max(1, Math.floor(limit)))
  const picked = await env.DB.prepare(
    `SELECT rowid AS rid, id, company, title, location, dedup_key, role_key
     FROM jobs
     WHERE closed_at IS NULL AND rowid > ?
     ORDER BY rowid
     LIMIT ?`,
  )
    .bind(after, size)
    .all<OpenJob>()
  const rows = picked.results
  if (rows.length === 0) return { after: 0, updated: 0 }

  const writes = []
  for (const row of rows) {
    const next = dedupKey(row.company, row.title, row.location) || null
    const role = roleKey(row.company, row.title) || null
    if ((row.dedup_key ?? null) === next && (row.role_key ?? null) === role) continue
    writes.push(
      env.DB.prepare(`UPDATE jobs SET dedup_key = ?, role_key = ? WHERE id = ?`).bind(next, role, row.id),
    )
  }
  await runBatch(env, writes)
  return { after: rows[rows.length - 1]!.rid, updated: writes.length }
}

/**
 * Drops duplicate_of when the copy is no longer the same place as its parent.
 * A score that was copied from the other city is cleared, unless someone has
 * already applied, written a note, or moved the row out of the machine statuses.
 */
export async function unlinkDedupBatch(
  env: Bindings,
  after: number,
  limit: number,
): Promise<{ after: number; unlinked: number; reset: number }> {
  const size = Math.min(200, Math.max(1, Math.floor(limit)))
  const picked = await env.DB.prepare(
    `SELECT c.rowid AS rid, c.id, c.company, c.title, c.location, c.dedup_key,
            p.company AS parent_company, p.title AS parent_title, p.location AS parent_location
     FROM jobs c
     JOIN jobs p ON p.id = c.duplicate_of
     WHERE c.closed_at IS NULL AND c.rowid > ?
     ORDER BY c.rowid
     LIMIT ?`,
  )
    .bind(after, size)
    .all<LinkedJob>()
  const rows = picked.results
  if (rows.length === 0) return { after: 0, unlinked: 0, reset: 0 }

  const moved = rows.filter((row) => {
    const child = dedupKey(row.company, row.title, row.location)
    const parent = dedupKey(row.parent_company, row.parent_title, row.parent_location)
    return child !== parent
  })
  await runBatch(
    env,
    moved.flatMap((row) => [
      env.DB.prepare(`UPDATE jobs SET duplicate_of = NULL WHERE id = ?`).bind(row.id),
      env.DB.prepare(RESET_SCORE).bind(row.id),
    ]),
  )
  return { after: rows[rows.length - 1]!.rid, unlinked: moved.length, reset: moved.length }
}
