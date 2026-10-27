import { getAdapter } from "./adapters"
import { bodyComesLater, fetchLateBody } from "./adapters/details"
import { fetchWorkdayLocations, WORKDAY_PLACEHOLDER } from "./adapters/workday"
import { boardRank } from "./boards"
import { companyKey, companiesRelated, dedupKey, jobHash, roleKey, titleKey } from "./company-key"
import { parsePlaces, placeCount, placesMatch } from "./places"
import { chunk, placeholders, runBatch, selectIn } from "./db"
import { message } from "./errors"
import { pick } from "./locale"
import { loadScoreQuota, QuotaError, quotaMessage } from "./quota"
import { deleteJobTexts, JOB_DESCRIPTION, JOB_TEXT_JOIN, NO_TEXT, saveJobText, saveJobTextIfEmpty, textHash } from "./job-text"
import { clipDescription, passesPrefilter } from "./prefilter"
import { toSalary } from "./salary"
import { scoreInBatches, scoreJobs, clampScoreConcurrency, type ScoreChunkEvent, type ScoreInput } from "./scoring"
import {
  excludeBlockedCompaniesForUser,
  resolveScoringConfig,
  resolveUserPrefilter,
} from "./settings"
import { trackCompany, type TrackResult } from "./sources"
import type { Bindings, RawJob, SourceRow } from "./types"
import { withUsage, type UsageContext } from "./usage"

type RunResult = {
  source_id: number
  ok: boolean
  jobs_found: number
  jobs_new: number
  error: string | null
  duration_ms: number
  suspicious: number
}

/**
 * "throttled" (scheduled runs and the master) walks every board at most once
 * in three hours. "catch_up" (a regular user's run) only covers what the last
 * scheduled run left behind: boards added since, boards it never reached, and
 * boards whose last attempt failed. With no scheduled run in the past day it
 * falls back to boards older than a day.
 */
export type SourcePolicy = "throttled" | "catch_up"

const STALE_SINCE: Record<SourcePolicy, string> = {
  throttled: `datetime('now', '-3 hours')`,
  catch_up: `max(
    COALESCE((SELECT MAX(started_at) FROM cycle_runs WHERE kind = 'auto'), ''),
    datetime('now', '-1 day')
  )`,
}

async function loadDueSources(db: D1Database, policy: SourcePolicy): Promise<SourceRow[]> {
  const res = await db
    .prepare(
      `SELECT s.* FROM sources s
       WHERE s.enabled = 1 AND s.deleted_at IS NULL
         AND (
           s.last_run_at IS NULL
           OR s.last_run_at < ${STALE_SINCE[policy]}
           OR COALESCE(
             (SELECT ok FROM source_runs r WHERE r.source_id = s.id ORDER BY r.id DESC LIMIT 1),
             0
           ) = 0
         )
       ORDER BY s.last_run_at ASC NULLS FIRST`,
    )
    .all<SourceRow>()
  return res.results
}

/**
 * D1 rejects a LIKE pattern longer than 50 bytes. A name match is a prefix
 * ("acme" covers "acme digital"), which is the same as a range: everything
 * from "acme " up to, but not including, "acme!". One statement can also bind
 * at most 100 values, so a full board is walked in slices.
 */
const TWIN_CHUNK = 20

async function loadRelatedTwins(env: Bindings, keys: string[], kind: "query" | "company"): Promise<TwinRow[]> {
  const unique = [...new Set(keys.filter(Boolean))]
  if (unique.length === 0) return []
  const out: TwinRow[] = []
  for (const part of chunk(unique, TWIN_CHUNK)) {
    const exact = [...new Set(part.flatMap((key) => [key, key.split(" ")[0] ?? key]))]
    const ranges = part.flatMap((key) => [`${key} `, `${key}!`])
    const clause = [
      `j.company_key IN (${placeholders(exact.length)})`,
      ...part.map(() => `(j.company_key >= ? AND j.company_key < ?)`),
    ].join(" OR ")
    const res = await env.DB.prepare(
      `SELECT j.id, j.role_key, j.dedup_key, j.company_key, j.title, j.location, s.kind, s.provider, j.first_seen_at, j.closed_at, j.duplicate_of,
              COALESCE(p.id, j.id) AS primary_id, COALESCE(p.location, j.location) AS primary_location,
              COALESCE(sp.kind, s.kind) AS primary_kind,
              COALESCE(sp.provider, s.provider) AS primary_provider,
              COALESCE(p.closed_at, j.closed_at) AS primary_closed_at
       FROM jobs j JOIN sources s ON s.id = j.source_id
       LEFT JOIN jobs p ON p.id = j.duplicate_of
       LEFT JOIN sources sp ON sp.id = p.source_id
       WHERE s.kind = ? AND (${clause})
       ORDER BY j.closed_at IS NULL DESC, j.closed_at DESC`,
    )
      .bind(kind, ...exact, ...ranges)
      .all<TwinRow>()
    out.push(...res.results)
  }
  return out
}

export function isSuspicious(lastCount: number | null, found: number): boolean {
  return lastCount != null && lastCount > 0 && found < lastCount * 0.5
}

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

type TwinRow = {
  id: string
  role_key: string
  kind: string
  first_seen_at: string
  closed_at: string | null
  company_key: string
  title: string
  location: string | null
  duplicate_of: string | null
  dedup_key: string | null
  primary_id: string
  primary_location: string | null
  primary_kind: string
  primary_provider: string
  primary_closed_at: string | null
}

export type SourceStep = RunResult & {
  more: boolean
  nextOffset: number
  runStart: string
}

/**
 * Rows written per hop. The slice exists so a hop finishes inside the Worker's
 * budget; since the writes go out in batches rather than one statement at a time,
 * it can be far wider than the round-trip-per-row version could afford.
 */
const SOURCE_CHUNK = 400
const FETCH_CACHE_MS = 10 * 60_000

type FetchCache = { key: string; jobs: RawJob[]; at: number }
let fetchCache: FetchCache | null = null

function timed<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

async function loadBoard(
  env: Bindings,
  source: SourceRow,
  runStart: string,
): Promise<RawJob[]> {
  const key = `${source.id}:${runStart}`
  if (fetchCache && fetchCache.key === key && Date.now() - fetchCache.at < FETCH_CACHE_MS) {
    return fetchCache.jobs
  }
  const adapter = getAdapter(source.provider)
  // A hop has to finish well inside the 30s waitUntil window. 35s let one
  // branded board eat the whole burst and then sit idle until the next cron.
  const jobs = await timed(
    adapter.fetchJobs(source.token, env),
    20_000,
    `${source.label}: fetch timed out`,
  )
  fetchCache = { key, jobs, at: Date.now() }
  return jobs
}

function clearBoardCache(): void {
  fetchCache = null
}

/**
 * Writes one slice of a board. Every read is done once for the whole slice and
 * every write goes out in batches: a statement per row used to cost a round trip,
 * and sixty rows of those is what pushed a cycle hop past the Worker's budget.
 */
/** Replaces a Workday "3 Locations" stub once, and again only if the title changes. */
async function fillWorkdayPlaces(
  env: Bindings,
  rows: Array<{ id: string; job: RawJob }>,
): Promise<void> {
  const stubs = rows.filter((row) => WORKDAY_PLACEHOLDER.test(row.job.location ?? ""))
  if (stubs.length === 0) return
  const known = new Map(
    (
      await selectIn<{ id: string; title: string; location: string | null }>(
        env,
        (list) => `SELECT id, title, location FROM jobs WHERE id IN (${list})`,
        stubs.map((row) => row.id),
      )
    ).map((row) => [row.id, row]),
  )
  const todo = stubs.filter((row) => {
    const saved = known.get(row.id)
    if (!saved) return true
    if (WORKDAY_PLACEHOLDER.test(saved.location ?? "")) return true
    return saved.title !== row.job.title
  })
  for (const part of chunk(todo, 2)) {
    await Promise.all(
      part.map(async (row) => {
        const places = await fetchWorkdayLocations(row.job.url)
        if (places) row.job.location = places
      }),
    )
  }
}

export async function upsertJobs(
  env: Bindings,
  source: SourceRow,
  jobs: RawJob[],
  watched: Set<string>,
): Promise<number> {
  if (jobs.length === 0) return 0

  const prepared = await Promise.all(
    jobs.map(async (job) => {
      const company = job.company ?? source.label
      return {
        job,
        company,
        key: companyKey(company),
        id: await jobHash(source.provider, source.token, job.externalId),
      }
    }),
  )
  if (source.provider === "workday") await fillWorkdayPlaces(env, prepared)
  const wanted = prepared.map((row) => ({
    ...row,
    opening: dedupKey(row.company, row.job.title, row.job.location) || null,
    role: roleKey(row.company, row.job.title) || null,
  }))

  const present = new Set(
    (
      await selectIn<{ id: string }>(
        env,
        (list) => `SELECT id FROM jobs WHERE id IN (${list})`,
        wanted.map((row) => row.id),
      )
    ).map((row) => row.id),
  )
  const byRole = new Map<string, TwinRow[]>()
  const roles = [...new Set(wanted.filter((row) => !present.has(row.id) && row.role).map((row) => row.role!))]
  // Closed rows are in scope on purpose: a board that takes an opening down and
  // puts it back gives it a new id, and the row we already have for it is closed
  // by then. A live twin still wins over a retired one.
  for (const twin of await selectIn<TwinRow>(
    env,
    (list) => `SELECT j.id, j.role_key, j.dedup_key, j.company_key, j.title, j.location, s.kind, s.provider,
         j.first_seen_at, j.closed_at, j.duplicate_of,
         COALESCE(p.id, j.id) AS primary_id,
         COALESCE(p.location, j.location) AS primary_location,
         COALESCE(sp.kind, s.kind) AS primary_kind,
         COALESCE(sp.provider, s.provider) AS primary_provider,
         COALESCE(p.closed_at, j.closed_at) AS primary_closed_at
       FROM jobs j JOIN sources s ON s.id = j.source_id
       LEFT JOIN jobs p ON p.id = j.duplicate_of
       LEFT JOIN sources sp ON sp.id = p.source_id
       WHERE j.role_key IN (${list})`,
    roles,
  )) {
    const list = byRole.get(twin.role_key) ?? []
    list.push(twin)
    byRole.set(twin.role_key, list)
  }
  const protectedIds = new Set(
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
        [...new Set([...byRole.values()].flatMap((list) => list.map((row) => row.primary_id)))],
      )
    ).map((row) => row.job_id),
  )

  const usedTwins = new Set<string>()
  const relatedKeys = [
    ...wanted.filter((row) => !present.has(row.id)).map((row) => row.key),
    companyKey(source.label),
    companyKey(source.token),
  ]
  const relatedTwins = await loadRelatedTwins(env, relatedKeys, source.kind === "company" ? "query" : "company")

  function matchesPlace(row: TwinRow, place: ReturnType<typeof parsePlaces>): boolean {
    return placesMatch(place, parsePlaces(row.primary_location ?? row.location))
  }

  function findTwin(role: string | null, key: string, opening: string | null, title: string, location: string | undefined): TwinRow | null {
    const words = titleKey(title)
    if (!words) return null
    const place = parsePlaces(location)
    const sameRole = (role && byRole.get(role)) || []
    const exact = opening ? sameRole.find((row) => row.dedup_key === opening && !usedTwins.has(row.id)) : undefined
    const found =
      exact ??
      sameRole.find((row) => !usedTwins.has(row.id) && matchesPlace(row, place)) ??
      relatedTwins.find(
        (row) =>
          !usedTwins.has(row.id) &&
          titleKey(row.title) === words &&
          companiesRelated(key, row.company_key) &&
          ((opening !== null && row.dedup_key === opening) || matchesPlace(row, place)),
      )
    return found ?? null
  }

  const storedHash = new Map<string, string | null>()
  const incoming = new Map<string, { text: string; hash: string }>()
  for (const row of wanted) {
    const text = clipDescription(row.job.description)
    if (text) incoming.set(row.id, { text, hash: await textHash(text) })
  }
  if (incoming.size > 0) {
    const known = await selectIn<{ id: string; text_hash: string | null }>(
      env,
      (list) => `SELECT id, text_hash FROM jobs WHERE id IN (${list})`,
      [...incoming.keys()],
    )
    for (const row of known) storedHash.set(row.id, row.text_hash)
  }

  const writes: D1PreparedStatement[] = []
  /** Openings already claimed by an earlier row of this same slice. */
  const claimed = new Set<string>()
  let jobsNew = 0
  let textsWritten = 0

  for (const { job, company, key, opening, role, id } of wanted) {
    const existing = present.has(id)
    // Two copies of one opening — same company, role and place — on the same
    // board: the first one wins. A second city is a different opening.
    if (opening && !existing && claimed.has(opening)) continue

    let inherit: TwinRow | null = null
    let duplicateOf: string | null = null
    let promote: TwinRow | null = null
    if (!existing) {
      const twin = findTwin(role, key, opening, job.title, job.location)
      if (twin) {
        const guarded = protectedIds.has(twin.primary_id)
        const incomingCount = placeCount(job.location)
        const currentCount = placeCount(twin.primary_location)
        const incomingRank = boardRank(source.provider)
        const currentRank = boardRank(twin.primary_provider)
        const fuller = incomingCount > currentCount && incomingRank === currentRank
        const strongerBoard = incomingRank > currentRank
        if (twin.closed_at && !twin.duplicate_of) {
          inherit = twin
          usedTwins.add(twin.id)
        } else if (twin.primary_closed_at) promote = twin
        else if (!guarded && (fuller || strongerBoard)) promote = twin
        else duplicateOf = twin.primary_id
      }
      if (opening) claimed.add(opening)
    }

    if (!existing) {
      jobsNew += 1
      present.add(id)
    }
    const body = incoming.get(id)
    const description = body?.text ?? null
    const textChanged = body !== undefined && body.hash !== (storedHash.get(id) ?? null)
    writes.push(
      env.DB.prepare(
        `INSERT INTO jobs (id, source_id, external_id, company, company_key, title, location, url, posted_at, salary_min, salary_max, salary_currency, dedup_key, role_key, text_hash, first_seen_at, last_seen_at, changed_at, closed_at, status, duplicate_of)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), datetime('now'), NULL, 'new', ?)
         ON CONFLICT(id) DO UPDATE SET
           last_seen_at = datetime('now'),
           title = excluded.title,
           location = excluded.location,
           dedup_key = excluded.dedup_key,
           role_key = excluded.role_key,
           closed_at = NULL,
           posted_at = COALESCE(excluded.posted_at, jobs.posted_at),
           salary_min = COALESCE(excluded.salary_min, jobs.salary_min),
           salary_max = COALESCE(excluded.salary_max, jobs.salary_max),
           salary_currency = COALESCE(excluded.salary_currency, jobs.salary_currency),
           text_hash = CASE WHEN ? = 1 THEN excluded.text_hash ELSE jobs.text_hash END,
           changed_at = CASE
             WHEN excluded.title IS NOT jobs.title
               OR IFNULL(excluded.location, '') IS NOT IFNULL(jobs.location, '')
               OR ? = 1
               OR (excluded.posted_at IS NOT NULL AND excluded.posted_at IS NOT IFNULL(jobs.posted_at, ''))
               OR IFNULL(excluded.salary_min, -1) IS NOT IFNULL(jobs.salary_min, -1)
               OR IFNULL(excluded.salary_max, -1) IS NOT IFNULL(jobs.salary_max, -1)
             THEN datetime('now')
             ELSE IFNULL(jobs.changed_at, jobs.first_seen_at)
           END`,
      ).bind(
        id,
        source.id,
        job.externalId,
        company,
        key,
        job.title,
        job.location ?? null,
        job.url,
        job.postedAt ?? null,
        job.salary?.min ?? null,
        job.salary?.max ?? null,
        job.salary?.currency || null,
        opening,
        role,
        body?.hash ?? null,
        duplicateOf,
        textChanged ? 1 : 0,
        textChanged ? 1 : 0,
      ),
    )
    if (textChanged && description) {
      writes.push(saveJobText(env, id, description))
      textsWritten += 1
    }

    if (promote) {
      writes.push(inheritFirstSeen(env, promote.first_seen_at, id))
      writes.push(inheritUserJobs(env, promote.primary_id, id))
      writes.push(env.DB.prepare(`UPDATE interview_stages SET job_id = ? WHERE job_id = ?`).bind(id, promote.primary_id))
      writes.push(
        env.DB.prepare(`UPDATE jobs SET duplicate_of = ? WHERE (id = ? OR duplicate_of = ?) AND id != ?`).bind(
          id,
          promote.primary_id,
          promote.primary_id,
          id,
        ),
      )
    }

    if (inherit) {
      writes.push(inheritFirstSeen(env, inherit.first_seen_at, id))
      writes.push(inheritUserJobs(env, inherit.id, id))
      writes.push(env.DB.prepare(`UPDATE interview_stages SET job_id = ? WHERE job_id = ?`).bind(id, inherit.id))
      writes.push(
        env.DB.prepare(`UPDATE jobs SET duplicate_of = ? WHERE duplicate_of = ?`).bind(id, inherit.id),
      )
      writes.push(deleteJobTexts(env, [inherit.id]))
      writes.push(env.DB.prepare(`DELETE FROM jobs WHERE id = ?`).bind(inherit.id))
    }

    if (source.kind === "query" && key && !watched.has(key)) {
      writes.push(
        env.DB.prepare(
          `INSERT INTO discovered_companies (company_key, company, first_seen_at, hits, sample_url, state)
           VALUES (?, ?, datetime('now'), 1, ?, 'new')
           ON CONFLICT(company_key) DO UPDATE SET
             hits = hits + 1,
             sample_url = COALESCE(discovered_companies.sample_url, excluded.sample_url)`,
        ).bind(key, company, job.url),
      )
    }
  }

  await runBatch(env, writes)
  if (incoming.size > 0) {
    console.log(`job texts written ${textsWritten} of ${incoming.size} with a body, ${jobsNew} new`)
  }
  return jobsNew
}

function inheritFirstSeen(env: Bindings, firstSeenAt: string, id: string): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE jobs SET first_seen_at = CASE WHEN ? < first_seen_at THEN ? ELSE first_seen_at END WHERE id = ?`,
  ).bind(firstSeenAt, firstSeenAt, id)
}

/**
 * Makes `jobId` the listing the lists show. The previous primary keeps its
 * row and becomes a duplicate; verdicts follow so an application stays on what
 * the person sees.
 */
export async function setPrimaryListing(env: Bindings, jobId: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT id, duplicate_of, first_seen_at FROM jobs WHERE id = ?`)
    .bind(jobId)
    .first<{ id: string; duplicate_of: string | null; first_seen_at: string }>()
  if (!row) return false
  const root = row.duplicate_of || row.id
  const group = await env.DB.prepare(
    `SELECT id, duplicate_of, first_seen_at FROM jobs WHERE id = ? OR duplicate_of = ?`,
  )
    .bind(root, root)
    .all<{ id: string; duplicate_of: string | null; first_seen_at: string }>()
  if (group.results.length < 2 || !group.results.some((item) => item.id === jobId)) return false
  const current = group.results.find((item) => !item.duplicate_of)
  if (current?.id === jobId) return true
  const writes: D1PreparedStatement[] = [
    env.DB.prepare(`UPDATE jobs SET duplicate_of = ? WHERE (id = ? OR duplicate_of = ?) AND id != ?`).bind(
      jobId,
      root,
      root,
      jobId,
    ),
    env.DB.prepare(`UPDATE jobs SET duplicate_of = NULL WHERE id = ?`).bind(jobId),
  ]
  if (current) {
    writes.push(inheritFirstSeen(env, current.first_seen_at, jobId))
    writes.push(inheritUserJobs(env, current.id, jobId))
  }
  await runBatch(env, writes)
  return true
}

/** Copies every person's verdict from one listing onto another of the same opening. */
function inheritUserJobs(env: Bindings, fromId: string, toId: string): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO user_jobs (
       user_id, job_id, status, score, score_reason, flags, notes,
       applied_at, viewed_at, later_at, notified_at, interviewed_at, cv_url, claude_comment
     )
     SELECT user_id, ?, status, score, score_reason, flags, notes,
            applied_at, viewed_at, later_at, notified_at, interviewed_at, cv_url, claude_comment
     FROM user_jobs WHERE job_id = ?
     ON CONFLICT(user_id, job_id) DO UPDATE SET
       cv_url = COALESCE(user_jobs.cv_url, excluded.cv_url),
       claude_comment = COALESCE(user_jobs.claude_comment, excluded.claude_comment),
       applied_at = COALESCE(user_jobs.applied_at, excluded.applied_at),
       viewed_at = COALESCE(user_jobs.viewed_at, excluded.viewed_at),
       later_at = COALESCE(user_jobs.later_at, excluded.later_at),
       interviewed_at = COALESCE(user_jobs.interviewed_at, excluded.interviewed_at),
       notes = COALESCE(user_jobs.notes, excluded.notes),
       status = CASE WHEN excluded.status IN ('applied', 'interview', 'rejected', 'saved', 'ignored')
         THEN excluded.status ELSE user_jobs.status END,
       score = COALESCE(user_jobs.score, excluded.score),
       score_reason = COALESCE(user_jobs.score_reason, excluded.score_reason),
       flags = COALESCE(user_jobs.flags, excluded.flags),
       notified_at = COALESCE(user_jobs.notified_at, excluded.notified_at)`,
  ).bind(toId, fromId)
}

/** One slice of a board so waitUntil can finish. Same source continues on the next hop. */
export async function runSourceStep(
  env: Bindings,
  source: SourceRow,
  offset: number,
  priorStart: string | null,
): Promise<SourceStep> {
  const started = Date.now()
  const nowRow = await env.DB.prepare(`SELECT datetime('now') AS now`).first<{ now: string }>()
  const runStart = priorStart ?? nowRow?.now ?? new Date().toISOString().replace("T", " ").slice(0, 19)
  try {
    const raw = await loadBoard(env, source, runStart)
    const slice = raw.slice(offset, offset + SOURCE_CHUNK)
    const watched = await trackedCompanyKeys(env.DB)
    const jobsNew = await upsertJobs(env, source, slice, watched)
    const nextOffset = offset + slice.length
    const more = nextOffset < raw.length
    const suspicious = isSuspicious(source.last_count, raw.length)

    if (!more) {
      if (!suspicious) await markMissingClosed(env, source, runStart)
      await archiveStaleSearchBoardJobs(env, source)
      await env.DB.prepare(
        `UPDATE sources SET last_count = ?, last_run_at = datetime('now') WHERE id = ?`,
      )
        .bind(raw.length, source.id)
        .run()
      await env.DB.prepare(
        `INSERT INTO source_runs (source_id, ok, jobs_found, jobs_new, error, duration_ms, suspicious)
         VALUES (?, 1, ?, ?, NULL, ?, ?)`,
      )
        .bind(source.id, raw.length, jobsNew, Date.now() - started, suspicious ? 1 : 0)
        .run()
      clearBoardCache()
    }

    return {
      source_id: source.id,
      ok: true,
      jobs_found: slice.length,
      jobs_new: jobsNew,
      error: null,
      duration_ms: Date.now() - started,
      suspicious: suspicious ? 1 : 0,
      more,
      nextOffset,
      runStart,
    }
  } catch (error) {
    clearBoardCache()
    const failure = message(error)
    await env.DB.prepare(`UPDATE sources SET last_run_at = datetime('now') WHERE id = ?`).bind(source.id).run()
    await env.DB.prepare(
      `INSERT INTO source_runs (source_id, ok, jobs_found, jobs_new, error, duration_ms, suspicious)
       VALUES (?, 0, NULL, NULL, ?, ?, 0)`,
    )
      .bind(source.id, failure, Date.now() - started)
      .run()
    return {
      source_id: source.id,
      ok: false,
      jobs_found: 0,
      jobs_new: 0,
      error: failure,
      duration_ms: Date.now() - started,
      suspicious: 0,
      more: false,
      nextOffset: 0,
      runStart,
    }
  }
}

export async function runSource(env: Bindings, source: SourceRow): Promise<RunResult> {
  let offset = 0
  let runStart: string | null = null
  let last: SourceStep | null = null
  let jobsNew = 0
  let found = 0
  do {
    last = await runSourceStep(env, source, offset, runStart)
    offset = last.nextOffset
    runStart = last.runStart
    jobsNew += last.jobs_new
    found += last.jobs_found
    if (!last.ok) return last
  } while (last.more)
  return {
    ...last,
    jobs_found: found,
    jobs_new: jobsNew,
  }
}

/** Employers we already follow on their own board, by label or ATS slug. */
export async function trackedCompanyKeys(db: D1Database): Promise<Set<string>> {
  const rows = await db
    .prepare(`SELECT label, token FROM sources WHERE deleted_at IS NULL AND kind = 'company'`)
    .all<{ label: string; token: string }>()
  const keys = new Set<string>()
  for (const row of rows.results) {
    for (const raw of [row.label, row.token]) {
      const key = companyKey(raw)
      if (key) keys.add(key)
    }
  }
  return keys
}

type Verdict = { score: number; score_reason: string | null; flags: string | null }

export type ScorePass = {
  scored: number
  remaining: number
  /** Whether another pass would still find work. Drives the cycle's scoring phase. */
  more: boolean
  /** Fresh claims are in flight, but this pass itself scored nothing. The walker should pause. */
  idle?: boolean
  /** The monthly limit left part of the queue unscored until it resets. */
  limited: boolean
}

/**
 * How many unscored rows one pass pulls in. Without a cap a large backlog made
 * every hop read the whole table, which is what used to burn D1's daily quota.
 */
const CLAIM_TTL = "-10 minutes"
const DEFAULT_SCORE_WINDOW_DAYS = 14
const CANDIDATE_WINDOW = 500

async function scoreWindowDays(env: Bindings, userId: number): Promise<number> {
  const row = await env.DB.prepare(`SELECT score_window_days FROM user_profiles WHERE user_id = ?`)
    .bind(userId)
    .first<{ score_window_days: number | null }>()
  const days = Number(row?.score_window_days)
  if (!Number.isFinite(days) || days <= 0) return DEFAULT_SCORE_WINDOW_DAYS
  return Math.min(3650, Math.floor(days))
}

async function freshScoringClaims(env: Bindings, userId: number): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM user_jobs
     WHERE user_id = ? AND scoring_claimed_at IS NOT NULL
       AND scoring_claimed_at >= datetime('now', ?)`,
  )
    .bind(userId, CLAIM_TTL)
    .first<{ n: number }>()
  return Number(row?.n ?? 0)
}

type Candidate = {
  id: string
  company: string
  company_key: string
  title: string
  location: string | null
  url: string
  no_text: number
  dedup_key: string | null
}

function parkOffProfile(env: Bindings, userId: number, ids: string[]): D1PreparedStatement[] {
  return chunk(ids, 40).map((part) =>
    env.DB.prepare(
      `INSERT INTO user_jobs (user_id, job_id, status, score, score_reason, flags)
       SELECT ?, id, 'off_profile', 0, 'prefilter', '[]' FROM jobs WHERE id IN (${placeholders(part.length)})
       ON CONFLICT(user_id, job_id) DO UPDATE SET
         status = 'off_profile', score = 0, score_reason = 'prefilter', flags = '[]'`,
    ).bind(userId, ...part),
  )
}

function verdictUpdate(env: Bindings, userId: number, id: string, verdict: Verdict): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO user_jobs (user_id, job_id, status, score, score_reason, flags)
     VALUES (?, ?, 'new', ?, ?, ?)
     ON CONFLICT(user_id, job_id) DO UPDATE SET
       score = excluded.score,
       score_reason = excluded.score_reason,
       flags = excluded.flags,
       scoring_claimed_at = NULL,
       scoring_claim_id = NULL,
       status = CASE WHEN user_jobs.status = 'off_profile' THEN 'new' ELSE user_jobs.status END`,
  ).bind(userId, id, verdict.score, verdict.score_reason, verdict.flags)
}

async function inheritVerdicts(
  env: Bindings,
  userId: number,
  keys: string[],
): Promise<Map<string, Verdict>> {
  const out = new Map<string, Verdict>()
  for (const part of chunk(keys, 80)) {
    const rows = await env.DB.prepare(
      `SELECT j.dedup_key, MAX(uj.score) AS score, uj.score_reason, uj.flags
       FROM jobs j INDEXED BY idx_jobs_dedup
       JOIN user_jobs uj ON uj.job_id = j.id AND uj.user_id = ?
       WHERE j.dedup_key IN (${placeholders(part.length)}) AND uj.score IS NOT NULL
         AND COALESCE(uj.score_reason, '') <> 'prefilter'
       GROUP BY j.dedup_key`,
    )
      .bind(userId, ...part)
      .all<Verdict & { dedup_key: string }>()
    for (const row of rows.results) out.set(row.dedup_key, row)
  }
  return out
}

async function profileContent(env: Bindings, userId: number): Promise<string> {
  const row = await env.DB.prepare(`SELECT content FROM user_profiles WHERE user_id = ?`)
    .bind(userId)
    .first<{ content: string }>()
  return row?.content ?? ""
}

/** How many detail pages to open at once. Workday rate-limits bursts. */
const DETAIL_CONCURRENCY = 6

/**
 * Some boards (Workday, Zalando) list postings without a body. Pull it before
 * the model runs and keep it, so the card and a later rescore don't fetch it again.
 */
async function fillLateDescriptions(
  env: Bindings,
  rows: Array<{ id: string; url: string; description: string | null }>,
): Promise<Map<string, string>> {
  const missing = rows.filter((row) => !row.description && bodyComesLater(row.url))
  const found = new Map<string, string>()
  const writes: D1PreparedStatement[] = []
  for (const part of chunk(missing, DETAIL_CONCURRENCY)) {
    const fetched = await Promise.all(
      part.map(async (row) => ({ id: row.id, text: await fetchLateBody(row.url) })),
    )
    for (const item of fetched) {
      if (!item.text) continue
      found.set(item.id, item.text)
      writes.push(saveJobTextIfEmpty(env, item.id, item.text))
      writes.push(
        env.DB.prepare(`UPDATE jobs SET text_hash = ? WHERE id = ? AND text_hash IS NULL`).bind(
          await textHash(item.text),
          item.id,
        ),
      )
    }
  }
  await runBatch(env, writes)
  return found
}

/**
 * Scores what the prefilter lets through. `limit` caps how many jobs reach the
 * model in one pass, so a caller that wants to report progress can walk the
 * queue in steps instead of waiting out one opaque request.
 */
export async function prefilterAndScore(
  env: Bindings,
  userId: number,
  limit?: number,
  usage: UsageContext = { kind: "score", userId, trigger: "manual" },
  options: { includeOld?: boolean; onlyIds?: string[] } = {},
): Promise<ScorePass> {
  const blocked = await excludeBlockedCompaniesForUser(env, userId, "j.company_key")
  const windowDays = await scoreWindowDays(env, userId)

  const open = await env.DB.prepare(
    `SELECT j.id, j.company, j.company_key, j.title, j.location, j.url, j.dedup_key,
            ${NO_TEXT} AS no_text
     FROM jobs j INDEXED BY idx_jobs_live
     ${JOB_TEXT_JOIN}
     LEFT JOIN user_jobs uj ON uj.job_id = j.id AND uj.user_id = ?
     WHERE j.closed_at IS NULL AND j.duplicate_of IS NULL AND uj.score IS NULL
       AND COALESCE(uj.status, 'new') NOT IN ('ignored', 'rejected', 'off_profile')
       AND (uj.scoring_claimed_at IS NULL OR uj.scoring_claimed_at < datetime('now', ?))
       AND COALESCE(uj.scoring_attempts, 0) < 3
       AND (? = 1 OR j.first_seen_at >= datetime('now', ?))
       AND (${options.onlyIds ? "j.id IN (SELECT value FROM json_each(?))" : "1=1"})
       AND ${blocked.sql}
     ORDER BY j.first_seen_at
     LIMIT ?`,
  )
    .bind(
      userId,
      CLAIM_TTL,
      options.includeOld || options.onlyIds ? 1 : 0,
      `-${windowDays} days`,
      ...(options.onlyIds ? [JSON.stringify(options.onlyIds)] : []),
      ...blocked.binds,
      CANDIDATE_WINDOW,
    )
    .all<Candidate>()

  const rules = await resolveUserPrefilter(env, userId)
  const candidates: Candidate[] = []
  const dropIds: string[] = []
  for (const job of open.results) {
    if (passesPrefilter(job.title, rules)) candidates.push(job)
    else dropIds.push(job.id)
  }

  await runBatch(env, parkOffProfile(env, userId, dropIds))

  const keys = [...new Set(candidates.map((job) => job.dedup_key).filter((key): key is string => Boolean(key)))]
  const verdicts = await inheritVerdicts(env, userId, keys)

  const toScore: Array<{ id: string; company_key: string; dedup_key: string | null; input: ScoreInput }> = []
  /** Twins of a job that is being scored right now, waiting for its verdict. */
  const awaiting = new Map<string, string[]>()
  const inherited: D1PreparedStatement[] = []

  for (const job of candidates) {
    const key = job.dedup_key
    // A row scored from the title alone has to be judged again once its
    // posting body is available. Inheriting that old verdict would skip it.
    const needsText = Boolean(job.no_text) && bodyComesLater(job.url)
    if (key && !needsText) {
      const known = verdicts.get(key)
      if (known) {
        inherited.push(verdictUpdate(env, userId, job.id, known))
        continue
      }
      const queued = awaiting.get(key)
      if (queued) {
        queued.push(job.id)
        continue
      }
      awaiting.set(key, [])
    }

    toScore.push({
      id: job.id,
      company_key: job.company_key,
      dedup_key: job.dedup_key,
      input: {
        external_id: job.id,
        title: job.title,
        company: job.company,
        location: job.location ?? "",
        description: "",
      },
    })
  }
  await runBatch(env, inherited)

  const config = await resolveScoringConfig(env)
  // Without a key the local heuristic scores for free, so only model calls are capped.
  const allowance = config.apiKey ? (await loadScoreQuota(env, userId)).remaining : null
  const cap = Math.min(limit || Infinity, allowance ?? Infinity)
  const wanted = toScore.slice(0, cap)
  const remaining = toScore.length - wanted.length
  const claim = crypto.randomUUID()
  let batch = wanted

  if (wanted.length > 0) {
    await runBatch(
      env,
      wanted.map((item) =>
        env.DB.prepare(`INSERT OR IGNORE INTO user_jobs (user_id, job_id) VALUES (?, ?)`).bind(userId, item.id),
      ),
    )
    await env.DB.prepare(
      `UPDATE user_jobs SET scoring_claimed_at = datetime('now'), scoring_claim_id = ?
       WHERE user_id = ? AND job_id IN (SELECT value FROM json_each(?)) AND score IS NULL
         AND (scoring_claimed_at IS NULL OR scoring_claimed_at < datetime('now', ?))`,
    )
      .bind(claim, userId, JSON.stringify(wanted.map((item) => item.id)), CLAIM_TTL)
      .run()
    const held = await env.DB.prepare(
      `SELECT job_id FROM user_jobs WHERE user_id = ? AND scoring_claim_id = ?`,
    )
      .bind(userId, claim)
      .all<{ job_id: string }>()
    const heldIds = new Set(held.results.map((row) => row.job_id))
    batch = wanted.filter((item) => heldIds.has(item.id))
  }

  if (batch.length > 0) {
    const bodies = await selectIn<{ id: string; url: string; description: string | null }>(
      env,
      (list) => `SELECT j.id, j.url, ${JOB_DESCRIPTION} AS description
         FROM jobs j ${JOB_TEXT_JOIN}
         WHERE j.id IN (${list})`,
      batch.map((item) => item.id),
    )
    const filled = await fillLateDescriptions(env, bodies)
    const byId = new Map(bodies.map((row) => [row.id, row.description ?? ""]))
    for (const [id, text] of filled) byId.set(id, text)
    for (const item of batch) {
      item.input.description = byId.get(item.id) ?? ""
    }
  }

  const byId = new Map(batch.map((item) => [item.id, item]))
  const concurrencyRow = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'score_concurrency'`)
    .first<{ value: string }>()

  async function releaseClaim(ids: string[], countAttempt: boolean) {
    if (ids.length === 0) return
    await env.DB.prepare(
      `UPDATE user_jobs SET
         scoring_claimed_at = NULL,
         scoring_claim_id = NULL,
         scoring_attempts = scoring_attempts + ?
       WHERE user_id = ? AND scoring_claim_id = ? AND job_id IN (${placeholders(ids.length)})`,
    )
      .bind(countAttempt ? 1 : 0, userId, claim, ...ids)
      .run()
  }

  async function noteScoringProgress(scored: number, failed: number) {
    if (scored === 0 && failed === 0) return
    await env.DB.prepare(
      `UPDATE cycles SET scored = scored + ?, failed_scoring = failed_scoring + ?, updated_at = datetime('now')
       WHERE id = 1 AND status = 'running' AND user_id = ?`,
    )
      .bind(scored, failed, userId)
      .run()
  }

  const profile = await profileContent(env, userId)
  let scores: Array<{ external_id: string; score: number; reason: string; flags: string[] }> = []
  let skipped = 0
  try {
    const scored = await withUsage(env, usage, config, (tracked) =>
      scoreInBatches(
        batch.map((item) => item.input),
        profile,
        tracked,
        {
          concurrency: clampScoreConcurrency(concurrencyRow?.value),
          onChunk: async (event: ScoreChunkEvent) => {
          const ids = event.jobs.map((job) => job.external_id)
          if (!event.ok) {
            await releaseClaim(ids, !event.rateLimited && !event.fatal)
            if (!event.rateLimited && !event.fatal) await noteScoringProgress(0, ids.length)
            return
          }
          const allowed = new Set(ids)
          const seen = new Set<string>()
          const valid: typeof event.scores = []
          const foreign: string[] = []
          for (const item of event.scores) {
            if (!allowed.has(item.external_id)) {
              foreign.push(item.external_id)
              continue
            }
            if (seen.has(item.external_id)) continue
            seen.add(item.external_id)
            valid.push(item)
          }
          if (foreign.length > 0) {
            console.warn(`scoring ignored ${foreign.length} ids outside the batch: ${foreign.join(", ")}`)
          }
          const writes: D1PreparedStatement[] = []
          for (const item of valid) {
            const verdict = { score: item.score, score_reason: item.reason, flags: JSON.stringify(item.flags) }
            writes.push(verdictUpdate(env, userId, item.external_id, verdict))
            const scoredJob = byId.get(item.external_id)
            if (!scoredJob) continue
            for (const twin of (scoredJob.dedup_key && awaiting.get(scoredJob.dedup_key)) || []) {
              writes.push(verdictUpdate(env, userId, twin, verdict))
            }
            if (scoredJob.company_key) {
              writes.push(
                env.DB.prepare(
                  `UPDATE discovered_companies
                   SET best_score = CASE WHEN best_score IS NULL OR best_score < ? THEN ? ELSE best_score END
                   WHERE company_key = ?`,
                ).bind(item.score, item.score, scoredJob.company_key),
              )
            }
          }
          if (valid.length > 0) {
            writes.push(
              env.DB.prepare(
                `UPDATE cycles SET scored = scored + ?, updated_at = datetime('now')
                 WHERE id = 1 AND status = 'running' AND user_id = ?`,
              ).bind(valid.length, userId),
            )
          }
          await runBatch(env, writes)
          const returned = new Set(valid.map((item) => item.external_id))
          const missing = ids.filter((id) => !returned.has(id))
          if (missing.length > 0) {
            await releaseClaim(missing, true)
            await noteScoringProgress(0, missing.length)
          }
          },
        },
      ),
    )
    scores = scored.scores
    skipped = scored.skipped
  } catch (error) {
    await env.DB.prepare(
      `UPDATE user_jobs SET scoring_claimed_at = NULL, scoring_claim_id = NULL
       WHERE user_id = ? AND scoring_claim_id = ?`,
    )
      .bind(userId, claim)
      .run()
    throw error
  }
  await bootstrapColdSources(env, userId)

  const pending = await freshScoringClaims(env, userId)
  const resolved = dropIds.length + inherited.length + scores.length
  const idle = pending > 0 && scores.length === 0 && skipped === 0 && remaining === 0
  return {
    scored: scores.length,
    remaining,
    more:
      skipped > 0 ||
      (remaining > 0 && scores.length > 0) ||
      (open.results.length === CANDIDATE_WINDOW && resolved > 0) ||
      pending > 0,
    ...(idle ? { idle: true } : {}),
    limited: allowance !== null && toScore.length > allowance,
  }
}

/**
 * A brand-new source arrives with its whole backlog, which would make one huge
 * digest. Mark it as already delivered rather than ignored, so it still shows up
 * in the admin.
 *
 * bootstrapped is one flag on the source, not per person. The first user whose
 * scoring pass sees the source marks it delivered for everyone. That is enough
 * while a single master owns the run.
 */
async function bootstrapColdSources(env: Bindings, userId: number): Promise<void> {
  const cold = await env.DB.prepare(
    `SELECT id FROM sources WHERE bootstrapped = 0 AND deleted_at IS NULL`,
  ).all<{ id: number }>()
  await runBatch(
    env,
    cold.results.flatMap((source) => [
      env.DB.prepare(
        `INSERT INTO user_jobs (user_id, job_id, status, notified_at)
         SELECT ?, j.id, COALESCE(uj.status, 'new'), datetime('now')
         FROM jobs j INDEXED BY idx_jobs_source_seen
         LEFT JOIN user_jobs uj ON uj.job_id = j.id AND uj.user_id = ?
         WHERE j.source_id = ? AND j.duplicate_of IS NULL
           AND COALESCE(uj.status, 'new') = 'new' AND uj.notified_at IS NULL
         ON CONFLICT(user_id, job_id) DO UPDATE SET
           notified_at = COALESCE(user_jobs.notified_at, excluded.notified_at)`,
      ).bind(userId, userId, source.id),
      env.DB.prepare(`UPDATE sources SET bootstrapped = 1 WHERE id = ?`).bind(source.id),
    ]),
  )
}

/**
 * Re-runs the title tags against open jobs after the user edits keep/drop.
 * Leaves saved / applied / ignored rows alone — those are a human decision.
 */
export async function reapplyPrefilter(
  env: Bindings,
  userId: number,
): Promise<{ dropped: number; restored: number }> {
  const rules = await resolveUserPrefilter(env, userId)
  const drop: string[] = []
  const restore: string[] = []
  let seen = ""
  let afterId = ""
  for (;;) {
    const rows = await env.DB.prepare(
      `SELECT j.id, j.title, j.first_seen_at, COALESCE(uj.status, 'new') AS status
       FROM jobs j INDEXED BY idx_jobs_live
       LEFT JOIN user_jobs uj ON uj.job_id = j.id AND uj.user_id = ?
       WHERE j.closed_at IS NULL AND j.duplicate_of IS NULL
         AND COALESCE(uj.status, 'new') IN ('new', 'notified', 'off_profile')
         AND (j.first_seen_at > ? OR (j.first_seen_at = ? AND j.id > ?))
       ORDER BY j.first_seen_at, j.id
       LIMIT 500`,
    )
      .bind(userId, seen, seen, afterId)
      .all<{ id: string; title: string; first_seen_at: string; status: string }>()
    if (rows.results.length === 0) break
    for (const row of rows.results) {
      const pass = passesPrefilter(row.title, rules)
      if (!pass && row.status !== "off_profile") drop.push(row.id)
      else if (pass && row.status === "off_profile") restore.push(row.id)
    }
    const last = rows.results[rows.results.length - 1]
    seen = last.first_seen_at
    afterId = last.id
    if (rows.results.length < 500) break
  }

  await runBatch(env, [
    ...parkOffProfile(env, userId, drop),
    ...chunk(restore, 40).map((part) =>
      env.DB.prepare(
        `INSERT INTO user_jobs (user_id, job_id, status, score, score_reason, flags)
         SELECT ?, id, 'new', NULL, NULL, NULL FROM jobs WHERE id IN (${placeholders(part.length)})
         ON CONFLICT(user_id, job_id) DO UPDATE SET
           score = NULL, score_reason = NULL, flags = NULL, status = 'new'`,
      ).bind(userId, ...part),
    ),
  ])
  return { dropped: drop.length, restored: restore.length }
}

export type ScoredJob = {
  id: string
  score: number
  score_reason: string | null
  flags: string | null
  status: string
}

/**
 * Scores postings regardless of prefilter or an existing verdict.
 * A manual click means "judge these rows", not "queue whatever is still new".
 */
export async function scoreJobsByIds(env: Bindings, ids: string[], userId: number): Promise<ScoredJob[]> {
  const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))].slice(0, 10)
  if (unique.length === 0) return []

  const rows = await env.DB.prepare(
    `SELECT j.id, j.company, j.company_key, j.title, j.location, j.url, ${JOB_DESCRIPTION} AS description, j.closed_at,
            COALESCE(uj.status, 'new') AS status
     FROM jobs j
     ${JOB_TEXT_JOIN}
     LEFT JOIN user_jobs uj ON uj.job_id = j.id AND uj.user_id = ?
     WHERE j.id IN (${unique.map(() => "?").join(", ")}) AND j.closed_at IS NULL`,
  )
    .bind(userId, ...unique)
    .all<{
      id: string
      company: string
      company_key: string
      title: string
      location: string | null
      url: string
      description: string | null
      status: string
      closed_at: string | null
    }>()
  if (rows.results.length === 0) throw new Error("not found")

  const config = await resolveScoringConfig(env)
  if (config.apiKey) {
    const quota = await loadScoreQuota(env, userId)
    if (quota.remaining !== null && quota.remaining < rows.results.length) throw new QuotaError(quotaMessage(quota))
  }

  const filled = await fillLateDescriptions(env, rows.results)
  const profile = await profileContent(env, userId)
  const scores = await withUsage(
    env,
    { kind: "job", userId, trigger: "manual" },
    config,
    (tracked) =>
      scoreJobs(
        rows.results.map((job) => ({
          external_id: job.id,
          title: job.title,
          company: job.company,
          location: job.location ?? "",
          description: filled.get(job.id) ?? job.description ?? "",
        })),
        profile,
        tracked,
      ),
  )
  const byId = new Map(scores.map((row) => [row.external_id, row]))

  const out: ScoredJob[] = []
  for (const job of rows.results) {
    const item = byId.get(job.id)
    if (!item) continue
    const flags = JSON.stringify(item.flags)
    const status = job.status === "off_profile" ? "new" : job.status
    await env.DB.prepare(
      `INSERT INTO user_jobs (user_id, job_id, status, score, score_reason, flags)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, job_id) DO UPDATE SET
         score = excluded.score, score_reason = excluded.score_reason, flags = excluded.flags,
         status = excluded.status`,
    )
      .bind(userId, job.id, status, item.score, item.reason || null, flags)
      .run()

    if (job.company_key) {
      await env.DB.prepare(
        `UPDATE discovered_companies
         SET best_score = CASE WHEN best_score IS NULL OR best_score < ? THEN ? ELSE best_score END
         WHERE company_key = ?`,
      )
        .bind(item.score, item.score, job.company_key)
        .run()
    }

    out.push({ id: job.id, score: item.score, score_reason: item.reason || null, flags, status })
  }
  if (out.length === 0) throw new Error(pick("The model returned no score", "Модель не вернула оценку"))
  return out
}

export async function scoreOneJob(env: Bindings, id: string, userId: number): Promise<ScoredJob> {
  const [job] = await scoreJobsByIds(env, [id], userId)
  if (!job) throw new Error("not found")
  return job
}

export async function notifyNew(_env: Bindings): Promise<number> {
  return 0
}

export async function pickSources(env: Bindings, policy: SourcePolicy = "throttled"): Promise<SourceRow[]> {
  return loadDueSources(env.DB, policy)
}

export async function addDiscovered(env: Bindings, key: string): Promise<TrackResult> {
  const row = await env.DB.prepare(
    `SELECT company, sample_url, careers_url FROM discovered_companies WHERE company_key = ?`,
  )
    .bind(key)
    .first<{ company: string; sample_url: string | null; careers_url: string | null }>()
  if (!row) throw new Error("not found")
  return trackCompany(env, key, row.company, row.careers_url ?? row.sample_url)
}

export type ManualJobInput = {
  title: string
  company: string
  url: string
  location?: string
  description?: string
  notes?: string
  salary_min?: unknown
  salary_max?: unknown
  salary_currency?: string
  status?: string
  applied_at?: string
}

function parseAppliedAt(raw: string | undefined): string | null {
  const value = raw?.trim() ?? ""
  if (!value) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value} 12:00:00`
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(value)) {
    return value.length === 16 ? `${value}:00` : value
  }
  return null
}

function parseJobUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim())
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    return url.href
  } catch {
    return null
  }
}

async function ensureManualSource(env: Bindings): Promise<number> {
  const existing = await env.DB.prepare(
    `SELECT id FROM sources WHERE provider = 'manual' AND token = 'manual'`,
  ).first<{ id: number }>()
  if (existing) return existing.id
  await env.DB.prepare(
    `INSERT INTO sources (kind, tier, label, provider, token, enabled)
     VALUES ('company', 'watchlist', 'Added by hand', 'manual', 'manual', 0)`,
  ).run()
  const created = await env.DB.prepare(
    `SELECT id FROM sources WHERE provider = 'manual' AND token = 'manual'`,
  ).first<{ id: number }>()
  if (!created) throw new Error("could not create manual source")
  return created.id
}

export async function createManualJob(env: Bindings, input: ManualJobInput, userId: number) {
  const title = input.title.trim()
  const company = input.company.trim()
  const url = parseJobUrl(input.url)
  if (!title || !company) throw new Error(pick("A title and a company are required", "Нужны должность и компания"))
  if (!url) throw new Error(pick("An http(s) link to the posting is required", "Нужна ссылка http(s) на позицию"))

  const status = input.status === "interview" ? "interview" : "applied"
  const sourceId = await ensureManualSource(env)
  const id = await jobHash("manual", "manual", url)
  const key = companyKey(company)
  const opening = dedupKey(company, title, input.location) || null
  const role = roleKey(company, title) || null
  const description = clipDescription(input.description) ?? null
  const hash = description ? await textHash(description) : null
  const notes = input.notes?.trim() || null
  const salary = toSalary({
    min: input.salary_min,
    max: input.salary_max,
    currency: input.salary_currency,
  })
  const appliedAt = parseAppliedAt(input.applied_at)

  await env.DB.prepare(
    `INSERT INTO jobs (
       id, source_id, external_id, company, company_key, title, location, url,
       posted_at, salary_min, salary_max, salary_currency, dedup_key, role_key, text_hash,
       first_seen_at, last_seen_at, changed_at, closed_at, status
     ) VALUES (
       ?, ?, ?, ?, ?, ?, ?, ?,
       NULL, ?, ?, ?, ?, ?, ?,
       datetime('now'), datetime('now'), datetime('now'), NULL, 'new'
     )
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       company = excluded.company,
       company_key = excluded.company_key,
       location = excluded.location,
       salary_min = COALESCE(excluded.salary_min, jobs.salary_min),
       salary_max = COALESCE(excluded.salary_max, jobs.salary_max),
       salary_currency = COALESCE(excluded.salary_currency, jobs.salary_currency),
       dedup_key = excluded.dedup_key,
       role_key = excluded.role_key,
       text_hash = COALESCE(excluded.text_hash, jobs.text_hash),
       closed_at = NULL,
       last_seen_at = datetime('now'),
       changed_at = datetime('now')`,
  )
    .bind(
      id,
      sourceId,
      url,
      company,
      key,
      title,
      input.location?.trim() || null,
      url,
      salary?.min ?? null,
      salary?.max ?? null,
      salary?.currency || null,
      opening,
      role,
      hash,
    )
    .run()

  if (description) await saveJobText(env, id, description).run()

  await env.DB.prepare(
    `INSERT INTO user_jobs (user_id, job_id, status, notes, applied_at, interviewed_at)
     VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')), CASE WHEN ? = 'interview' THEN COALESCE(?, datetime('now')) END)
     ON CONFLICT(user_id, job_id) DO UPDATE SET
       status = excluded.status,
       notes = COALESCE(excluded.notes, user_jobs.notes),
       applied_at = COALESCE(user_jobs.applied_at, excluded.applied_at),
       interviewed_at = COALESCE(user_jobs.interviewed_at, excluded.interviewed_at)`,
  )
    .bind(userId, id, status, notes, appliedAt, status, appliedAt)
    .run()

  const job = await env.DB.prepare(
    `SELECT j.id, j.source_id, j.company, j.company_key, j.title, j.location, j.url,
            j.posted_at, j.first_seen_at, j.last_seen_at, j.changed_at,
            j.salary_min, j.salary_max, j.salary_currency,
            uj.score, uj.score_reason, uj.flags, COALESCE(uj.status, 'new') AS status,
            uj.applied_at, uj.viewed_at, uj.later_at, uj.interviewed_at, uj.notes, ${JOB_DESCRIPTION} AS description,
            s.tier, s.label as source_label
     FROM jobs j
     ${JOB_TEXT_JOIN}
     JOIN sources s ON s.id = j.source_id
     LEFT JOIN user_jobs uj ON uj.job_id = j.id AND uj.user_id = ?
     WHERE j.id = ?`,
  )
    .bind(userId, id)
    .first()
  if (!job) throw new Error("not found")
  return job
}
