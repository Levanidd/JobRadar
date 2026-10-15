import { getAdapter } from "./adapters"
import { bodyComesLater, fetchLateBody } from "./adapters/details"
import { companyKey, companiesRelated, dedupKey, jobHash, titleKey } from "./company-key"
import { chunk, placeholders, runBatch, selectIn } from "./db"
import { message } from "./errors"
import { clipDescription, passesPrefilter } from "./prefilter"
import { toSalary } from "./salary"
import { scoreInBatches, scoreJobs, type ScoreInput } from "./scoring"
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
      `SELECT j.id, j.company_key, j.title, s.kind, j.first_seen_at, j.closed_at, j.duplicate_of
       FROM jobs j JOIN sources s ON s.id = j.source_id
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

type TwinRow = {
  id: string
  kind: string
  first_seen_at: string
  closed_at: string | null
  company_key: string
  title: string
  duplicate_of: string | null
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
export async function upsertJobs(
  env: Bindings,
  source: SourceRow,
  jobs: RawJob[],
  watched: Set<string>,
): Promise<number> {
  if (jobs.length === 0) return 0

  const wanted = await Promise.all(
    jobs.map(async (job) => {
      const company = job.company ?? source.label
      return {
        job,
        company,
        key: companyKey(company),
        opening: dedupKey(company, job.title) || null,
        id: await jobHash(source.provider, source.token, job.externalId),
      }
    }),
  )

  const present = new Set(
    (
      await selectIn<{ id: string }>(
        env,
        (list) => `SELECT id FROM jobs WHERE id IN (${list})`,
        wanted.map((row) => row.id),
      )
    ).map((row) => row.id),
  )
  const twins = new Map<string, TwinRow>()
  const openings = [...new Set(wanted.filter((row) => !present.has(row.id) && row.opening).map((row) => row.opening!))]
  // Closed rows are in scope on purpose: a board that takes an opening down and
  // puts it back gives it a new id, and the row we already have for it is closed
  // by then. A live twin still wins over a retired one.
  for (const twin of await selectIn<TwinRow & { dedup_key: string }>(
    env,
    (list) => `SELECT j.id, j.dedup_key, j.company_key, j.title, s.kind, j.first_seen_at, j.closed_at, j.duplicate_of
       FROM jobs j JOIN sources s ON s.id = j.source_id
       WHERE j.dedup_key IN (${list})
       ORDER BY j.closed_at IS NULL DESC, j.closed_at DESC`,
    openings,
  )) {
    if (!twins.has(twin.dedup_key)) twins.set(twin.dedup_key, twin)
  }

  const usedTwins = new Set<string>()
  const relatedKeys = [
    ...wanted.filter((row) => !present.has(row.id)).map((row) => row.key),
    companyKey(source.label),
    companyKey(source.token),
  ]
  const relatedTwins = await loadRelatedTwins(env, relatedKeys, source.kind === "company" ? "query" : "company")

  function findTwin(opening: string | null, key: string, title: string): TwinRow | null {
    if (opening) {
      const exact = twins.get(opening)
      if (exact && !usedTwins.has(exact.id)) return exact
    }
    const role = titleKey(title)
    if (!role) return null
    return (
      relatedTwins.find(
        (row) => !usedTwins.has(row.id) && titleKey(row.title) === role && companiesRelated(key, row.company_key),
      ) ?? null
    )
  }

  const writes: D1PreparedStatement[] = []
  /** Openings already claimed by an earlier row of this same slice. */
  const claimed = new Set<string>()
  let jobsNew = 0

  for (const { job, company, key, opening, id } of wanted) {
    const existing = present.has(id)
    // Two copies of one opening on the same board: the first one wins, exactly
    // as it did when each row looked itself up against the rows written before it.
    if (opening && !existing && claimed.has(opening)) continue

    let inherit: TwinRow | null = null
    let duplicateOf: string | null = null
    if (!existing) {
      const twin = findTwin(opening, key, job.title)
      if (twin) {
        usedTwins.add(twin.id)
        if (opening) twins.delete(opening)
        // A retired twin is the same opening re-posted under a new id: it has
        // to hand over its history, otherwise whoever already applied sees a
        // brand-new vacancy. A live twin stays — both listings are kept, and
        // the one already in the list remains the primary until a person picks.
        if (twin.closed_at) inherit = twin
        else duplicateOf = twin.duplicate_of || twin.id
      }
      if (opening) claimed.add(opening)
    }

    if (!existing) {
      jobsNew += 1
      present.add(id)
    }
    const description = clipDescription(job.description) ?? null
    writes.push(
      env.DB.prepare(
        `INSERT INTO jobs (id, source_id, external_id, company, company_key, title, location, url, description, posted_at, salary_min, salary_max, salary_currency, dedup_key, first_seen_at, last_seen_at, changed_at, closed_at, status, duplicate_of)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), datetime('now'), NULL, 'new', ?)
         ON CONFLICT(id) DO UPDATE SET
           last_seen_at = datetime('now'),
           title = excluded.title,
           location = excluded.location,
           dedup_key = excluded.dedup_key,
           closed_at = NULL,
           posted_at = COALESCE(excluded.posted_at, jobs.posted_at),
           description = COALESCE(excluded.description, jobs.description),
           salary_min = COALESCE(excluded.salary_min, jobs.salary_min),
           salary_max = COALESCE(excluded.salary_max, jobs.salary_max),
           salary_currency = COALESCE(excluded.salary_currency, jobs.salary_currency),
           changed_at = CASE
             WHEN excluded.title IS NOT jobs.title
               OR IFNULL(excluded.location, '') IS NOT IFNULL(jobs.location, '')
               OR (excluded.description IS NOT NULL AND excluded.description IS NOT IFNULL(jobs.description, ''))
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
        description,
        job.postedAt ?? null,
        job.salary?.min ?? null,
        job.salary?.max ?? null,
        job.salary?.currency || null,
        opening,
        duplicateOf,
      ),
    )

    if (inherit) {
      writes.push(inheritFirstSeen(env, inherit.first_seen_at, id))
      writes.push(inheritUserJobs(env, inherit.id, id))
      writes.push(env.DB.prepare(`UPDATE interview_stages SET job_id = ? WHERE job_id = ?`).bind(id, inherit.id))
      writes.push(
        env.DB.prepare(`UPDATE jobs SET duplicate_of = ? WHERE duplicate_of = ?`).bind(id, inherit.id),
      )
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
  return jobsNew
}

function inheritFirstSeen(env: Bindings, firstSeenAt: string, id: string): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE jobs SET first_seen_at = CASE WHEN ? < first_seen_at THEN ? ELSE first_seen_at END WHERE id = ?`,
  ).bind(firstSeenAt, firstSeenAt, id)
}

/**
 * Makes `jobId` the listing the lists show. The previous primary keeps its
 * row and becomes a duplicate; verdicts follow so «подался» stays on what
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
      if (!suspicious) {
        await env.DB.prepare(
          `UPDATE jobs SET closed_at = datetime('now')
           WHERE source_id = ? AND closed_at IS NULL AND last_seen_at < ?`,
        )
          .bind(source.id, runStart)
          .run()
      }
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
}

/**
 * How many unscored rows one pass pulls in. Without a cap a large backlog made
 * every hop read the whole table, which is what used to burn D1's daily quota.
 */
const CANDIDATE_WINDOW = 500

type Candidate = {
  id: string
  company: string
  company_key: string
  title: string
  location: string | null
  url: string
  description: string | null
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
       FROM user_jobs uj JOIN jobs j ON j.id = uj.job_id
       WHERE uj.user_id = ? AND uj.score IS NOT NULL AND j.dedup_key IN (${placeholders(part.length)})
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
      writes.push(
        env.DB.prepare(`UPDATE jobs SET description = ? WHERE id = ? AND description IS NULL`).bind(item.text, item.id),
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
): Promise<ScorePass> {
  const blocked = await excludeBlockedCompaniesForUser(env, userId, "j.company_key")

  const open = await env.DB.prepare(
    `SELECT j.id, j.company, j.company_key, j.title, j.location, j.url, j.description, j.dedup_key
     FROM jobs j
     LEFT JOIN user_jobs uj ON uj.job_id = j.id AND uj.user_id = ?
     WHERE j.closed_at IS NULL AND j.duplicate_of IS NULL AND uj.score IS NULL
       AND COALESCE(uj.status, 'new') NOT IN ('ignored', 'rejected', 'off_profile')
       AND ${blocked.sql}
     ORDER BY j.first_seen_at
     LIMIT ?`,
  )
    .bind(userId, ...blocked.binds, CANDIDATE_WINDOW)
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
    const needsText = !job.description && bodyComesLater(job.url)
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

  const batch = limit ? toScore.slice(0, limit) : toScore
  const remaining = toScore.length - batch.length

  if (batch.length > 0) {
    const bodies = await selectIn<{ id: string; url: string; description: string | null }>(
      env,
      (list) => `SELECT id, url, description FROM jobs WHERE id IN (${list})`,
      batch.map((item) => item.id),
    )
    const filled = await fillLateDescriptions(env, bodies)
    const byId = new Map(bodies.map((row) => [row.id, row.description ?? ""]))
    for (const [id, text] of filled) byId.set(id, text)
    for (const item of batch) {
      item.input.description = byId.get(item.id) ?? ""
    }
  }

  const profile = await profileContent(env, userId)
  const { scores, skipped } = await withUsage(env, usage, await resolveScoringConfig(env), (config) =>
    scoreInBatches(
      batch.map((item) => item.input),
      profile,
      config,
    ),
  )

  const byId = new Map(batch.map((item) => [item.id, item]))
  const writes: D1PreparedStatement[] = []
  for (const item of scores) {
    const verdict = { score: item.score, score_reason: item.reason, flags: JSON.stringify(item.flags) }
    writes.push(verdictUpdate(env, userId, item.external_id, verdict))

    const scored = byId.get(item.external_id)
    if (!scored) continue
    for (const twin of (scored.dedup_key && awaiting.get(scored.dedup_key)) || []) {
      writes.push(verdictUpdate(env, userId, twin, verdict))
    }
    if (scored.company_key) {
      writes.push(
        env.DB.prepare(
          `UPDATE discovered_companies
           SET best_score = CASE WHEN best_score IS NULL OR best_score < ? THEN ? ELSE best_score END
           WHERE company_key = ?`,
        ).bind(item.score, item.score, scored.company_key),
      )
    }
  }
  await runBatch(env, writes)
  await bootstrapColdSources(env, userId)

  const resolved = dropIds.length + inherited.length + scores.length
  return {
    scored: scores.length,
    remaining,
    more:
      skipped > 0 ||
      (remaining > 0 && scores.length > 0) ||
      (open.results.length === CANDIDATE_WINDOW && resolved > 0),
  }
}

/**
 * A brand-new source arrives with its whole backlog, which would make one huge
 * digest. Mark it as already delivered rather than ignored, so it still shows up
 * in the admin.
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
         FROM jobs j
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
  const rows = await env.DB.prepare(
    `SELECT j.id, j.title, COALESCE(uj.status, 'new') AS status
     FROM jobs j
     LEFT JOIN user_jobs uj ON uj.job_id = j.id AND uj.user_id = ?
     WHERE j.closed_at IS NULL AND j.duplicate_of IS NULL
       AND COALESCE(uj.status, 'new') IN ('new', 'notified', 'off_profile')`,
  )
    .bind(userId)
    .all<{ id: string; title: string; status: string }>()

  const drop: string[] = []
  const restore: string[] = []
  for (const row of rows.results) {
    const pass = passesPrefilter(row.title, rules)
    if (!pass && row.status !== "off_profile") drop.push(row.id)
    else if (pass && row.status === "off_profile") restore.push(row.id)
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
    `SELECT j.id, j.company, j.company_key, j.title, j.location, j.url, j.description, j.closed_at,
            COALESCE(uj.status, 'new') AS status
     FROM jobs j
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

  const filled = await fillLateDescriptions(env, rows.results)
  const profile = await profileContent(env, userId)
  const scores = await withUsage(
    env,
    { kind: "job", userId, trigger: "manual" },
    await resolveScoringConfig(env),
    (config) =>
      scoreJobs(
        rows.results.map((job) => ({
          external_id: job.id,
          title: job.title,
          company: job.company,
          location: job.location ?? "",
          description: filled.get(job.id) ?? job.description ?? "",
        })),
        profile,
        config,
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
  if (out.length === 0) throw new Error("Модель не вернула оценку")
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
     VALUES ('company', 'watchlist', 'Вручную', 'manual', 'manual', 0)`,
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
  if (!title || !company) throw new Error("Нужны должность и компания")
  if (!url) throw new Error("Нужна ссылка http(s) на позицию")

  const status = input.status === "interview" ? "interview" : "applied"
  const sourceId = await ensureManualSource(env)
  const id = await jobHash("manual", "manual", url)
  const key = companyKey(company)
  const opening = dedupKey(company, title) || null
  const description = clipDescription(input.description) ?? null
  const notes = input.notes?.trim() || null
  const salary = toSalary({
    min: input.salary_min,
    max: input.salary_max,
    currency: input.salary_currency,
  })
  const appliedAt = parseAppliedAt(input.applied_at)

  await env.DB.prepare(
    `INSERT INTO jobs (
       id, source_id, external_id, company, company_key, title, location, url, description,
       posted_at, salary_min, salary_max, salary_currency, dedup_key,
       first_seen_at, last_seen_at, changed_at, closed_at, status
     ) VALUES (
       ?, ?, ?, ?, ?, ?, ?, ?, ?,
       NULL, ?, ?, ?, ?,
       datetime('now'), datetime('now'), datetime('now'), NULL, 'new'
     )
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       company = excluded.company,
       company_key = excluded.company_key,
       location = excluded.location,
       description = COALESCE(excluded.description, jobs.description),
       salary_min = COALESCE(excluded.salary_min, jobs.salary_min),
       salary_max = COALESCE(excluded.salary_max, jobs.salary_max),
       salary_currency = COALESCE(excluded.salary_currency, jobs.salary_currency),
       dedup_key = excluded.dedup_key,
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
      description,
      salary?.min ?? null,
      salary?.max ?? null,
      salary?.currency || null,
      opening,
    )
    .run()

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
            uj.applied_at, uj.viewed_at, uj.later_at, uj.interviewed_at, uj.notes, j.description,
            s.tier, s.label as source_label
     FROM jobs j
     JOIN sources s ON s.id = j.source_id
     LEFT JOIN user_jobs uj ON uj.job_id = j.id AND uj.user_id = ?
     WHERE j.id = ?`,
  )
    .bind(userId, id)
    .first()
  if (!job) throw new Error("not found")
  return job
}
