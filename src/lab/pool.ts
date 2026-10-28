import { bodyComesLater, fetchLateBody } from "../adapters/details"
import { chunk, placeholders } from "../db"
import { pick } from "../locale"
import { sampleJobs, type PoolEntry } from "./sample"
import { HAS_TEXT, JOB_DESCRIPTION, JOB_TEXT_JOIN } from "../job-text"
import { clipDescription } from "../prefilter"
import type { Bindings } from "../types"
import { DETAIL_CONCURRENCY, type LabJob, type LabParams, POOL_CACHE_MS, POOL_STATUSES } from "./shared"

type PoolRow = { job_id: string; score: number; status: string; url: string; has_text: number }

/** Keyed by the database binding so a test's fresh database never sees another test's pool. */
const poolCache = new WeakMap<object, Map<number, { at: number; pool: PoolEntry[] }>>()

/**
 * One read for the whole pool, without descriptions: id, baseline and status
 * are all the sampler needs. A posting whose body only arrives from its detail
 * page counts too; the body is fetched for the picked ones alone.
 */
async function readPool(env: Bindings, userId: number): Promise<PoolEntry[]> {
  const rows = await env.DB.prepare(
    `SELECT uj.job_id, uj.score, uj.status, j.url, ${HAS_TEXT} AS has_text
     FROM user_jobs uj JOIN jobs j ON j.id = uj.job_id
     ${JOB_TEXT_JOIN}
     WHERE uj.user_id = ? AND uj.status IN (${placeholders(POOL_STATUSES.length)})
       AND uj.score IS NOT NULL AND COALESCE(uj.score_reason, '') <> 'prefilter'
       AND j.duplicate_of IS NULL
     ORDER BY uj.score DESC
     LIMIT 5000`,
  )
    .bind(userId, ...POOL_STATUSES)
    .all<PoolRow>()
  const pool = rows.results
    .filter((row) => row.has_text || bodyComesLater(row.url))
    .map(({ job_id, score, status }) => ({ job_id, score, status }))
  const cache = poolCache.get(env.DB) ?? new Map()
  cache.set(userId, { at: Date.now(), pool })
  poolCache.set(env.DB, cache)
  return pool
}

/** The preview is asked on every keystroke of the form; the pool barely changes within a minute or two. */
export async function cachedPool(env: Bindings, userId: number): Promise<PoolEntry[]> {
  const hit = poolCache.get(env.DB)?.get(userId)
  if (hit && Date.now() - hit.at < POOL_CACHE_MS) return hit.pool
  return readPool(env, userId)
}

type SourceRow = {
  id: string
  title: string
  company: string
  location: string | null
  url: string
  description: string | null
  score: number | null
  score_reason: string | null
  flags: string | null
  status: string
}

export type JobSnapshot = Omit<LabJob, "position"> & { description: string }

async function loadSourceRows(env: Bindings, userId: number, ids: string[]): Promise<SourceRow[]> {
  if (ids.length === 0) return []
  const rows = await env.DB.prepare(
    `SELECT j.id, j.title, j.company, j.location, j.url, ${JOB_DESCRIPTION} AS description,
       uj.score, uj.score_reason, uj.flags, uj.status
     FROM jobs j ${JOB_TEXT_JOIN}
     JOIN user_jobs uj ON uj.job_id = j.id AND uj.user_id = ?
     WHERE j.id IN (SELECT value FROM json_each(?))`,
  )
    .bind(userId, JSON.stringify(ids))
    .all<SourceRow>()
  return rows.results
}

/** Read-only: unlike scoring, the lab keeps a fetched body to itself and never writes it back to jobs. */
async function fetchLateBodies(rows: SourceRow[], into: Map<string, string>): Promise<void> {
  for (const part of chunk(rows, DETAIL_CONCURRENCY)) {
    const fetched = await Promise.all(
      part.map(async (row) => ({ id: row.id, text: await fetchLateBody(row.url).catch(() => null) })),
    )
    for (const item of fetched) into.set(item.id, item.text ?? "")
  }
}

export async function drawSample(env: Bindings, params: LabParams): Promise<{ jobs: JobSnapshot[]; warnings: string[] }> {
  let pool = await readPool(env, params.user_id)
  const warnings: string[] = []
  if (pool.length > 0 && pool.length < params.sample_size) {
    warnings.push(pick(`Only ${pool.length} in the pool — the run took all of them`, `В пуле только ${pool.length} — прогон взял все`))
  }
  const late = new Map<string, string>()
  for (let round = 0; ; round++) {
    const picks = sampleJobs(pool, {
      size: params.sample_size,
      mode: params.sample_mode,
      includeLabeled: params.include_labeled,
      seed: params.seed,
    })
    const rows = new Map((await loadSourceRows(env, params.user_id, picks.map((pick) => pick.job_id))).map((row) => [row.id, row]))
    await fetchLateBodies(
      [...rows.values()].filter((row) => !row.description && !late.has(row.id) && bodyComesLater(row.url)),
      late,
    )
    const text = (id: string) => clipDescription(rows.get(id)?.description || late.get(id) || undefined) ?? ""
    const lost = picks.filter((pick) => !text(pick.job_id))
    if (lost.length > 0 && round < 2) {
      const gone = new Set(lost.map((pick) => pick.job_id))
      pool = pool.filter((entry) => !gone.has(entry.job_id))
      continue
    }
    if (lost.length > 0) {
      warnings.push(
        pick(
          `${lost.length} postings had no description — the sample is smaller`,
          `У ${lost.length} вакансий не загрузилось описание — выборка меньше`,
        ),
      )
    }
    const jobs = picks.flatMap((pick): JobSnapshot[] => {
      const row = rows.get(pick.job_id)
      const description = text(pick.job_id)
      if (!row || !description) return []
      return [
        {
          job_id: row.id,
          stratum: pick.stratum,
          title: row.title,
          company: row.company,
          location: row.location,
          url: row.url,
          description,
          baseline_score: row.score,
          baseline_reason: row.score_reason,
          baseline_flags: row.flags,
          baseline_status: row.status,
        },
      ]
    })
    return { jobs, warnings }
  }
}

// ---------- prices and estimate ----------
