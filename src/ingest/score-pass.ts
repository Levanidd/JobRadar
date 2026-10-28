import { bodyComesLater, fetchLateBody } from "../adapters/details"
import { flagTags, readRepost, recentExactRepost, repostStaysVisible } from "../repost"
import { chunk, placeholders, runBatch, selectIn } from "../db"
import { pick } from "../locale"
import { loadScoreQuota, QuotaError, quotaMessage } from "../quota"
import { JOB_DESCRIPTION, JOB_TEXT_JOIN, NO_TEXT, saveJobTextIfEmpty, textHash } from "../job-text"
import { passesPrefilter } from "../prefilter"
import { scoreInBatches, scoreJobs, clampScoreConcurrency, type ScoreChunkEvent, type ScoreInput } from "../scoring"
import { excludeBlockedCompaniesForUser, resolveScoringConfig, resolveUserPrefilter } from "../settings"
import type { Bindings } from "../types"
import { withUsage, type UsageContext } from "../usage"

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
  flags: string | null
}

function parkOffProfile(env: Bindings, userId: number, ids: string[]): D1PreparedStatement[] {
  return chunk(ids, 40).map((part) =>
    env.DB.prepare(
      `INSERT INTO user_jobs (user_id, job_id, status, score, score_reason, flags)
       SELECT ?, id, 'off_profile', 0, 'prefilter', '[]' FROM jobs WHERE id IN (${placeholders(part.length)})
       ON CONFLICT(user_id, job_id) DO UPDATE SET
         status = 'off_profile', score = 0, score_reason = 'prefilter',
         flags = CASE WHEN COALESCE(user_jobs.flags, '') LIKE '%"repost_of"%' THEN user_jobs.flags ELSE '[]' END`,
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
       flags = CASE WHEN COALESCE(user_jobs.flags, '') LIKE '%"repost_of"%' THEN user_jobs.flags ELSE excluded.flags END,
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
    `SELECT j.id, j.company, j.company_key, j.title, j.location, j.url, j.dedup_key, uj.flags,
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
  const repostIds: string[] = []
  for (const job of open.results) {
    if (recentExactRepost(job.flags)) {
      const repost = readRepost(job.flags)
      if (!repost || !repostStaysVisible(repost, flagTags(job.flags), job.location)) {
        repostIds.push(job.id)
        continue
      }
    }
    if (passesPrefilter(job.title, rules)) candidates.push(job)
    else dropIds.push(job.id)
  }

  await runBatch(env, [
    ...parkOffProfile(env, userId, dropIds),
    ...chunk(repostIds, 40).map((part) =>
      env.DB.prepare(
        `UPDATE user_jobs SET status = 'off_profile'
         WHERE user_id = ? AND job_id IN (${placeholders(part.length)})
           AND applied_at IS NULL AND status NOT IN ('applied', 'interview', 'rejected', 'saved')`,
      ).bind(userId, ...part),
    ),
  ])

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
         score = excluded.score, score_reason = excluded.score_reason,
         flags = CASE WHEN COALESCE(user_jobs.flags, '') LIKE '%"repost_of"%' THEN user_jobs.flags ELSE excluded.flags END,
         status = CASE WHEN COALESCE(user_jobs.flags, '') LIKE '%"repost_of"%' AND user_jobs.status = 'off_profile'
           THEN user_jobs.status ELSE excluded.status END`,
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
