import { getAdapter } from "../adapters"
import { companyKey } from "../company-key"
import { message } from "../errors"
import { trackCompany, type TrackResult } from "../sources"
import type { Bindings, RawJob, SourceRow } from "../types"
import { archiveStaleSearchBoardJobs, markMissingClosed } from "./closing"
import { upsertJobs } from "./upsert"

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

export function isSuspicious(lastCount: number | null, found: number): boolean {
  return lastCount != null && lastCount > 0 && found < lastCount * 0.5
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
