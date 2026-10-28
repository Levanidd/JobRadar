import { getAdapter } from "../adapters"
import { boardRank } from "../boards"
import { placeCount } from "../places"
import { placeholders, runBatch, selectIn } from "../db"
import { deleteJobTexts, JOB_DESCRIPTION, JOB_TEXT_JOIN } from "../job-text"
import type { Bindings, SourceRow } from "../types"
import { inheritFirstSeen, inheritUserJobs } from "./upsert"

/**
 * Search boards hand back a fresh window, not the live set. A miss there is
 * the page limit, so a posting stays open for a month from the day we first
 * saw it. A company board is the whole listing, and a miss there is a takedown.
 */
const MONTH = "-1 month"

export function boardKeepsYoungMisses(provider: string): boolean {
  return getAdapter(provider).kind === "query"
}

type OpenChild = {
  id: string
  duplicate_of: string
  location: string | null
  first_seen_at: string
  provider: string
}

function compareListings(
  a: OpenChild,
  b: OpenChild,
  guarded: Set<string>,
): number {
  const guard = Number(guarded.has(b.id)) - Number(guarded.has(a.id))
  if (guard !== 0) return guard
  const rank = boardRank(b.provider) - boardRank(a.provider)
  if (rank !== 0) return rank
  const places = placeCount(b.location) - placeCount(a.location)
  if (places !== 0) return places
  return a.first_seen_at < b.first_seen_at ? -1 : a.first_seen_at > b.first_seen_at ? 1 : 0
}

/**
 * An open copy pointing at a closed primary is invisible. One open copy becomes
 * the primary; the rest follow it. A copy someone has acted on is never demoted.
 */
export async function releaseClosedPrimaries(env: Bindings, sourceId: number | null = null): Promise<string[]> {
  const promoted: string[] = []
  for (;;) {
    const parents = await env.DB.prepare(
      `SELECT p.id, p.first_seen_at FROM jobs p
       WHERE p.closed_at IS NOT NULL AND p.duplicate_of IS NULL
         AND (? IS NULL OR p.source_id = ?)
         AND EXISTS (SELECT 1 FROM jobs c WHERE c.duplicate_of = p.id AND c.closed_at IS NULL)
       LIMIT 40`,
    )
      .bind(sourceId, sourceId)
      .all<{ id: string; first_seen_at: string }>()
    if (parents.results.length === 0) break
    const parentIds = parents.results.map((row) => row.id)
    const parentSeen = new Map(parents.results.map((row) => [row.id, row.first_seen_at]))
    const children = await env.DB.prepare(
      `SELECT c.id, c.duplicate_of, c.location, c.first_seen_at, s.provider
       FROM jobs c JOIN sources s ON s.id = c.source_id
       WHERE c.closed_at IS NULL AND c.duplicate_of IN (${placeholders(parentIds.length)})`,
    )
      .bind(...parentIds)
      .all<OpenChild>()
    if (children.results.length === 0) break
    const guarded = new Set(
      (
        await selectIn<{ job_id: string }>(
          env,
          (list) => `SELECT DISTINCT job_id FROM user_jobs
             WHERE job_id IN (${list})
               AND (applied_at IS NOT NULL OR interviewed_at IS NOT NULL
                 OR TRIM(COALESCE(notes, '')) != ''
                 OR TRIM(COALESCE(cv_url, '')) != ''
                 OR TRIM(COALESCE(claude_comment, '')) != ''
                 OR COALESCE(status, 'new') NOT IN ('new', 'off_profile'))`,
          children.results.map((row) => row.id),
        )
      ).map((row) => row.job_id),
    )
    const byParent = new Map<string, OpenChild[]>()
    for (const child of children.results) {
      const list = byParent.get(child.duplicate_of) ?? []
      list.push(child)
      byParent.set(child.duplicate_of, list)
    }
    const writes: D1PreparedStatement[] = []
    const raised: string[] = []
    for (const [parent, group] of byParent) {
      const protectedChildren = group.filter((row) => guarded.has(row.id))
      const pool = protectedChildren.length > 1 ? protectedChildren : group
      const heir = [...pool].sort((a, b) => compareListings(a, b, guarded))[0]!
      const standAlone = protectedChildren.length > 1 ? protectedChildren : [heir]
      for (const row of standAlone) {
        writes.push(env.DB.prepare(`UPDATE jobs SET duplicate_of = NULL WHERE id = ?`).bind(row.id))
        raised.push(row.id)
      }
      for (const row of group) {
        if (standAlone.some((item) => item.id === row.id)) continue
        writes.push(env.DB.prepare(`UPDATE jobs SET duplicate_of = ? WHERE id = ?`).bind(heir.id, row.id))
      }
      writes.push(inheritFirstSeen(env, parentSeen.get(parent) ?? heir.first_seen_at, heir.id))
      writes.push(inheritUserJobs(env, parent, heir.id))
      writes.push(env.DB.prepare(`UPDATE interview_stages SET job_id = ? WHERE job_id = ?`).bind(heir.id, parent))
    }
    writes.push(
      env.DB.prepare(`INSERT OR IGNORE INTO dedup_released (job_id) SELECT value FROM json_each(?)`).bind(
        JSON.stringify(raised),
      ),
    )
    await runBatch(env, writes)
    promoted.push(...raised)
    if (parents.results.length < 40) break
  }
  return promoted
}

export async function markMissingClosed(env: Bindings, source: SourceRow, runStart: string): Promise<void> {
  const grace = boardKeepsYoungMisses(source.provider) ? 1 : 0
  await env.DB.prepare(
    `UPDATE jobs SET closed_at = datetime('now')
     WHERE source_id = ? AND closed_at IS NULL AND last_seen_at < ?
       AND (? = 0 OR first_seen_at < datetime('now', ?))`,
  )
    .bind(source.id, runStart, grace, MONTH)
    .run()
  const promoted = await releaseClosedPrimaries(env, source.id)
  if (promoted.length > 0) console.log(`promoted ${promoted.length} open copies from under a closed primary`)
}

/** D1 binds at most 100 values, and a hop has to finish inside the worker budget. */
const STALE_ARCHIVE_CHUNK = 80
const STALE_ARCHIVE_PASSES = 40

/**
 * A primary that is about to leave must hand its closed copies to one heir.
 * Nulling every duplicate_of would turn each copy into its own opening.
 * Live copies keep the primary here for this pass.
 */
async function retargetClosedCopies(env: Bindings, parentIds: string[]): Promise<D1PreparedStatement[]> {
  if (parentIds.length === 0) return []
  const children = await env.DB.prepare(
    `SELECT id, duplicate_of, first_seen_at FROM jobs
     WHERE duplicate_of IN (${placeholders(parentIds.length)})
     ORDER BY first_seen_at, id`,
  )
    .bind(...parentIds)
    .all<{ id: string; duplicate_of: string; first_seen_at: string }>()
  const groups = new Map<string, string[]>()
  for (const child of children.results) {
    const list = groups.get(child.duplicate_of) ?? []
    list.push(child.id)
    groups.set(child.duplicate_of, list)
  }
  const writes: D1PreparedStatement[] = []
  for (const [parent, ids] of groups) {
    const heir = ids[0]
    writes.push(env.DB.prepare(`UPDATE jobs SET duplicate_of = NULL WHERE id = ?`).bind(heir))
    if (ids.length > 1) {
      writes.push(
        env.DB.prepare(`UPDATE jobs SET duplicate_of = ? WHERE duplicate_of = ? AND id != ?`).bind(heir, parent, heir),
      )
    }
  }
  return writes
}

/** Anything a person attached, or an application, keeps the posting in the live list. */
const WORTH_KEEPING = `uj.applied_at IS NOT NULL OR uj.interviewed_at IS NOT NULL
  OR uj.status IN ('applied', 'interview')
  OR TRIM(COALESCE(uj.notes, '')) != ''
  OR TRIM(COALESCE(uj.claude_comment, '')) != ''
  OR TRIM(COALESCE(uj.cv_url, '')) != ''`

/**
 * A search-board posting that fell out of the window, has been closed for a
 * month, and nobody applied to, annotated, or attached a CV to, moves into
 * the archive tables. Company boards stay in the live table.
 */
export async function archiveStaleSearchBoardJobs(env: Bindings, source: SourceRow): Promise<number> {
  if (!boardKeepsYoungMisses(source.provider)) return 0
  let moved = 0
  for (let pass = 0; pass < STALE_ARCHIVE_PASSES; pass += 1) {
    const picked = await env.DB.prepare(
      `SELECT j.id FROM jobs j INDEXED BY idx_jobs_source_closed
       WHERE j.source_id = ? AND j.closed_at IS NOT NULL AND j.closed_at < datetime('now', ?)
         AND j.applied_at IS NULL AND TRIM(COALESCE(j.notes, '')) = ''
         AND NOT EXISTS (
           SELECT 1 FROM user_jobs uj WHERE uj.job_id = j.id AND (${WORTH_KEEPING})
         )
         AND NOT EXISTS (
           SELECT 1 FROM jobs live WHERE live.duplicate_of = j.id AND live.closed_at IS NULL
         )
       LIMIT ?`,
    )
      .bind(source.id, MONTH, STALE_ARCHIVE_CHUNK)
      .all<{ id: string }>()
    const ids = picked.results.map((row) => row.id)
    if (ids.length === 0) break
    const marks = placeholders(ids.length)
    const heirs = await retargetClosedCopies(env, ids)
    await runBatch(env, [
      env.DB.prepare(
        `INSERT OR REPLACE INTO archive_jobs (
           id, source_id, source_provider, source_label, source_kind,
           external_id, company, company_key, title, location, url, description,
           posted_at, first_seen_at, last_seen_at, closed_at, changed_at,
           dedup_key, duplicate_of, status, score, score_reason, flags, notified_at,
           notes, applied_at, viewed_at, later_at, salary_min, salary_max, salary_currency,
           archived_at
         )
         SELECT j.id, j.source_id, s.provider, s.label, s.kind,
           j.external_id, j.company, j.company_key, j.title, j.location, j.url, ${JOB_DESCRIPTION},
           j.posted_at, j.first_seen_at, j.last_seen_at, j.closed_at, j.changed_at,
           j.dedup_key, j.duplicate_of, j.status, j.score, j.score_reason, j.flags, j.notified_at,
           j.notes, j.applied_at, j.viewed_at, j.later_at, j.salary_min, j.salary_max, j.salary_currency,
           datetime('now')
         FROM jobs j JOIN sources s ON s.id = j.source_id
         ${JOB_TEXT_JOIN}
         WHERE j.id IN (${marks})`,
      ).bind(...ids),
      env.DB.prepare(
        `INSERT OR REPLACE INTO archive_user_jobs (
           user_id, job_id, status, score, score_reason, flags, notes,
           applied_at, viewed_at, later_at, notified_at, interviewed_at, cv_url, claude_comment,
           archived_at
         )
         SELECT user_id, job_id, status, score, score_reason, flags, notes,
           applied_at, viewed_at, later_at, notified_at, interviewed_at, cv_url, claude_comment,
           datetime('now')
         FROM user_jobs WHERE job_id IN (${marks})`,
      ).bind(...ids),
      env.DB.prepare(
        `INSERT OR REPLACE INTO archive_interview_stages (
           id, user_id, job_id, title, happened_on, created_at, archived_at
         )
         SELECT id, user_id, job_id, title, happened_on, created_at, datetime('now')
         FROM interview_stages WHERE job_id IN (${marks})`,
      ).bind(...ids),
      ...heirs,
      deleteJobTexts(env, ids),
      env.DB.prepare(`DELETE FROM jobs WHERE id IN (${marks})`).bind(...ids),
    ])
    moved += ids.length
    if (ids.length < STALE_ARCHIVE_CHUNK) break
  }
  return moved
}
