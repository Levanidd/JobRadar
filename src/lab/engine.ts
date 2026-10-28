import { placeholders, runBatch } from "../db"
import { d1LimitMessage, isD1LimitError, message } from "../errors"
import { pick } from "../locale"
import { ScoringError, scoreOne, scoringErrorCode, type ModelCall, type ScoringErrorCode } from "../scoring"
import { providerKey, providerKeyName } from "../settings"
import type { Bindings } from "../types"
import { recordCalls } from "../usage"
import { ERROR_LIMIT, HEARTBEAT_MS, LAB_CONCURRENCY, LIVE, type LabCandidate, type LabRunRow, type LabStatus, MAX_ATTEMPTS, MAX_HOPS, RATE_LIMIT_PAUSE_MS, RAW_LIMIT, RETRYABLE, STALE, TRIAL_TIMEOUT_MS, WALK_BUDGET_MS } from "./shared"

type Claimed = { id: number; candidate_id: number; job_id: string; attempts: number }

type Outcome = {
  id: number
  candidate_id: number
  status: "ok" | "failed" | "pending"
  score: number | null
  reason: string | null
  flags: string | null
  raw: string | null
  code: ScoringErrorCode | null
  error: string | null
  input: number | null
  output: number | null
  thought: number | null
  duration: number
  calls: ModelCall[]
}

type Step = { more: boolean; waitMs: number; owned: boolean }

const STOP: Step = { more: false, waitMs: 0, owned: false }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ScoringError(`no answer in ${ms / 1000} s`, "timeout")), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function tokens(calls: ModelCall[]): Pick<Outcome, "input" | "output" | "thought"> {
  if (calls.length === 0) return { input: null, output: null, thought: null }
  return {
    input: calls.reduce((sum, call) => sum + call.input_tokens, 0),
    output: calls.reduce((sum, call) => sum + call.output_tokens, 0),
    thought: calls.reduce((sum, call) => sum + call.thought_tokens, 0),
  }
}

const RECOUNT = `UPDATE lab_runs SET
    done = (SELECT COUNT(*) FROM lab_trials WHERE lab_run_id = ?1 AND status IN ('ok', 'failed')),
    failed = (SELECT COUNT(*) FROM lab_trials WHERE lab_run_id = ?1 AND status = 'failed'),
    updated_at = datetime('now')
  WHERE id = ?1`

export function recount(env: Bindings, runId: number): D1PreparedStatement {
  return env.DB.prepare(RECOUNT).bind(runId)
}

async function failRun(env: Bindings, runId: number, error: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE lab_runs SET status = 'error', error = ?, updated_at = datetime('now'), finished_at = datetime('now')
     WHERE id = ? AND ${LIVE}`,
  )
    .bind(error, runId)
    .run()
}

async function remaining(env: Bindings, runId: number): Promise<{ pending: number; running: number }> {
  const rows = await env.DB.prepare(
    `SELECT status, COUNT(*) AS n FROM lab_trials
     WHERE lab_run_id = ? AND status IN ('pending', 'running') GROUP BY status`,
  )
    .bind(runId)
    .all<{ status: string; n: number }>()
  const count = (status: string) => Number(rows.results.find((row) => row.status === status)?.n ?? 0)
  return { pending: count("pending"), running: count("running") }
}

async function finishRun(env: Bindings, runId: number): Promise<void> {
  await runBatch(env, [
    recount(env, runId),
    env.DB.prepare(
      `UPDATE lab_runs SET status = 'done', finished_at = datetime('now'), error = NULL WHERE id = ? AND status = 'running'`,
    ).bind(runId),
  ])
}

async function runTrial(
  env: Bindings,
  run: LabRunRow,
  trial: Claimed,
  candidate: LabCandidate | undefined,
  job: { job_id: string; title: string; company: string; location: string | null; description: string } | undefined,
): Promise<Outcome> {
  const calls: ModelCall[] = []
  const started = Date.now()
  const base = { id: trial.id, candidate_id: trial.candidate_id, score: null, reason: null, flags: null, calls }
  const apiKey = candidate ? providerKey(env, candidate.provider) : undefined
  if (!candidate || !job || !apiKey) {
    const error =
      !candidate || !job
        ? pick("Trial snapshot was not found", "Снапшот попытки не найден")
        : pick(`${providerKeyName(candidate.provider)} is not configured`, `${providerKeyName(candidate.provider)} не настроен`)
    return { ...base, status: "failed", raw: null, code: "error", error, ...tokens([]), duration: 0 }
  }
  // Provider errors sometimes echo the key back; it must not reach the tables, the model log or the API.
  const redact = (text: string) => text.split(apiKey).join("***")
  try {
    const { score, text } = await withTimeout(
      scoreOne(
        {
          external_id: job.job_id,
          title: job.title,
          company: job.company,
          location: job.location ?? "",
          description: job.description,
        },
        run.system_prompt,
        {
          provider: candidate.provider,
          apiKey,
          model: candidate.model,
          thinkingLevel: candidate.thinking_level ?? undefined,
          onCall: (call) => calls.push(call.error ? { ...call, error: redact(call.error) } : call),
        },
      ),
      TRIAL_TIMEOUT_MS,
    )
    return {
      ...base,
      status: "ok",
      score: score.score,
      reason: score.reason,
      flags: JSON.stringify(score.flags),
      raw: redact(text).slice(0, RAW_LIMIT),
      code: null,
      error: null,
      ...tokens(calls),
      duration: calls.at(-1)?.duration_ms ?? Date.now() - started,
    }
  } catch (error) {
    const code = scoringErrorCode(error)
    const retry = RETRYABLE.includes(code) && trial.attempts < MAX_ATTEMPTS
    const raw = error instanceof ScoringError && error.text ? redact(error.text).slice(0, RAW_LIMIT) : null
    return {
      ...base,
      status: retry ? "pending" : "failed",
      raw,
      code,
      error: redact(message(error)).slice(0, ERROR_LIMIT),
      ...tokens(calls),
      duration: Date.now() - started,
    }
  }
}

async function runTrials(env: Bindings, run: LabRunRow, claimed: Claimed[]): Promise<Outcome[]> {
  const jobIds = [...new Set(claimed.map((trial) => trial.job_id))]
  const [candidates, jobs] = await Promise.all([
    env.DB.prepare(`SELECT * FROM lab_candidates WHERE lab_run_id = ?`).bind(run.id).all<LabCandidate>(),
    env.DB.prepare(
      `SELECT job_id, title, company, location, description FROM lab_jobs
       WHERE lab_run_id = ? AND job_id IN (${placeholders(jobIds.length)})`,
    )
      .bind(run.id, ...jobIds)
      .all<{ job_id: string; title: string; company: string; location: string | null; description: string }>(),
  ])
  const candidateById = new Map(candidates.results.map((row) => [row.id, row]))
  const jobById = new Map(jobs.results.map((row) => [row.job_id, row]))

  // A slow model can keep a hop busy past the stale mark; the heartbeat tells
  // cron and the open tab that this walker is alive and they should not start another.
  const heartbeat = setInterval(() => {
    env.DB.prepare(`UPDATE lab_runs SET updated_at = datetime('now') WHERE id = ? AND status = 'running'`)
      .bind(run.id)
      .run()
      .catch(() => undefined)
  }, HEARTBEAT_MS)
  try {
    return await Promise.all(
      claimed.map((trial) => runTrial(env, run, trial, candidateById.get(trial.candidate_id), jobById.get(trial.job_id))),
    )
  } finally {
    clearInterval(heartbeat)
  }
}

async function writeOutcomes(env: Bindings, runId: number, outcomes: Outcome[]): Promise<void> {
  const writes = outcomes.map((outcome) =>
    env.DB.prepare(
      `UPDATE lab_trials SET status = ?1, score = ?2, reason = ?3, flags = ?4, raw_response = ?5,
         error_code = ?6, error = ?7, input_tokens = ?8, output_tokens = ?9, thought_tokens = ?10, duration_ms = ?11,
         claimed_at = CASE WHEN ?1 = 'pending' THEN NULL ELSE claimed_at END,
         finished_at = CASE WHEN ?1 = 'pending' THEN NULL ELSE datetime('now') END
       WHERE id = ?12 AND status = 'running'`,
    ).bind(
      outcome.status,
      outcome.score,
      outcome.reason,
      outcome.flags,
      outcome.raw,
      outcome.code,
      outcome.error,
      outcome.input,
      outcome.output,
      outcome.thought,
      outcome.duration,
      outcome.id,
    ),
  )
  // A retry handed back after the run was cancelled must not sit in the queue forever.
  writes.push(
    env.DB.prepare(
      `UPDATE lab_trials SET status = 'cancelled'
       WHERE lab_run_id = ?1 AND status = 'pending'
         AND EXISTS (SELECT 1 FROM lab_runs WHERE id = ?1 AND status = 'cancelled')`,
    ).bind(runId),
  )
  writes.push(recount(env, runId))
  writes.push(
    env.DB.prepare(`UPDATE lab_runs SET error = NULL WHERE id = ? AND ${LIVE} AND error IS NOT NULL`).bind(runId),
  )
  await runBatch(env, writes)
}

/** All calls of a lab run go into one model_batches row, opened by the first hop that made a call. */
async function logUsage(env: Bindings, run: LabRunRow, calls: ModelCall[]): Promise<void> {
  if (calls.length === 0) return
  try {
    const id = await recordCalls(
      env,
      { kind: "lab", userId: run.created_by, trigger: "manual", batchId: run.usage_batch_id },
      calls,
    )
    if (id && id !== run.usage_batch_id) {
      await env.DB.prepare(`UPDATE lab_runs SET usage_batch_id = COALESCE(usage_batch_id, ?) WHERE id = ?`)
        .bind(id, run.id)
        .run()
    }
  } catch (error) {
    console.error("lab usage log failed", error)
  }
}

async function advance(env: Bindings, run: LabRunRow, pauses: Map<number, number>): Promise<Step> {
  // A trial claimed by a walker that Cloudflare killed would otherwise stay `running` forever.
  await env.DB.prepare(
    `UPDATE lab_trials SET
       status = CASE WHEN attempts >= ?2 THEN 'failed' ELSE 'pending' END,
       error_code = CASE WHEN attempts >= ?2 THEN 'timeout' ELSE error_code END,
       error = CASE WHEN attempts >= ?2 THEN ?3 ELSE error END,
       finished_at = CASE WHEN attempts >= ?2 THEN datetime('now') ELSE NULL END,
       claimed_at = NULL
     WHERE lab_run_id = ?1 AND status = 'running' AND claimed_at < datetime('now', '-90 seconds')`,
  )
    .bind(run.id, MAX_ATTEMPTS, pick("The worker dropped this trial", "попытка брошена воркером"))
    .run()

  const now = Date.now()
  const paused = [...pauses].filter(([, until]) => until > now).map(([candidateId]) => candidateId)
  const claimed = await env.DB.prepare(
    `UPDATE lab_trials SET status = 'running', claimed_at = datetime('now'), attempts = attempts + 1
     WHERE id IN (
       SELECT id FROM lab_trials
       WHERE lab_run_id = ? AND status = 'pending'
         ${paused.length ? `AND candidate_id NOT IN (${placeholders(paused.length)})` : ""}
       ORDER BY exec_order LIMIT ?
     )
     RETURNING id, candidate_id, job_id, attempts`,
  )
    .bind(run.id, ...paused, LAB_CONCURRENCY)
    .all<Claimed>()

  if (claimed.results.length === 0) {
    const left = await remaining(env, run.id)
    if (left.pending > 0) {
      const until = Math.min(...paused.map((candidateId) => pauses.get(candidateId) ?? now))
      return { more: true, waitMs: Math.max(0, until - now), owned: true }
    }
    if (left.running === 0) await finishRun(env, run.id)
    return { more: false, waitMs: 0, owned: true }
  }

  const outcomes = await runTrials(env, run, claimed.results)
  await writeOutcomes(env, run.id, outcomes)
  for (const outcome of outcomes) {
    if (outcome.code === "http_429") pauses.set(outcome.candidate_id, Date.now() + RATE_LIMIT_PAUSE_MS)
  }
  await logUsage(
    env,
    run,
    outcomes.flatMap((outcome) => outcome.calls),
  )

  const left = await remaining(env, run.id)
  if (left.pending === 0 && left.running === 0) {
    await finishRun(env, run.id)
    return { more: false, waitMs: 0, owned: true }
  }
  return { more: left.pending > 0, waitMs: 0, owned: true }
}

/** One hop: up to LAB_CONCURRENCY trials in parallel, then their results in one batch. */
export async function tickLab(env: Bindings, runId: number, pauses = new Map<number, number>()): Promise<Step> {
  const run = await env.DB.prepare(`SELECT * FROM lab_runs WHERE id = ?`).bind(runId).first<LabRunRow>()
  if (!run || (run.status !== "queued" && run.status !== "running")) return STOP
  if (run.hops >= MAX_HOPS) {
    await failRun(env, runId, "lab exceeded hop limit")
    return STOP
  }
  const cas = await env.DB.prepare(
    `UPDATE lab_runs SET hops = hops + 1, status = 'running', started_at = COALESCE(started_at, datetime('now')),
       updated_at = datetime('now')
     WHERE id = ? AND ${LIVE} AND hops = ?`,
  )
    .bind(runId, run.hops)
    .run()
  if (!Number(cas.meta.changes)) return STOP

  try {
    return await advance(env, { ...run, status: "running", hops: run.hops + 1 }, pauses)
  } catch (error) {
    const detail = message(error)
    // Out of reads for today: keep the run alive, it carries on after midnight UTC.
    if (isD1LimitError(detail)) {
      await env.DB.prepare(`UPDATE lab_runs SET error = ? WHERE id = ?`)
        .bind(d1LimitMessage(), runId)
        .run()
        .catch(() => undefined)
      return STOP
    }
    await failRun(env, runId, detail)
    return STOP
  }
}

/**
 * Walks the run after the HTTP response. On running out of budget with work
 * left it hands the run back (backdated updated_at), so the open tab or the
 * next cron picks it up at once instead of waiting out the stale mark.
 */
export async function walkLab(env: Bindings, runId: number): Promise<void> {
  const started = Date.now()
  const pauses = new Map<number, number>()
  let step: Step = STOP
  try {
    while (Date.now() - started < WALK_BUDGET_MS) {
      step = await tickLab(env, runId, pauses)
      if (!step.more) return
      if (step.waitMs > 0) await sleep(Math.min(step.waitMs, Math.max(0, WALK_BUDGET_MS - (Date.now() - started))))
    }
  } catch (error) {
    await failRun(env, runId, message(error)).catch(() => undefined)
    return
  }
  if (step.owned && step.more) {
    await env.DB.prepare(`UPDATE lab_runs SET updated_at = datetime('now', '-26 seconds') WHERE id = ? AND ${LIVE}`)
      .bind(runId)
      .run()
      .catch(() => undefined)
  }
}

/** Claims a live run nobody is moving, so of several kicks only one starts a walker. */
async function claimStale(env: Bindings, runId?: number): Promise<number | null> {
  const sql = `UPDATE lab_runs SET updated_at = datetime('now')
    WHERE ${LIVE} ${runId ? "AND id = ?" : ""} AND (updated_at IS NULL OR updated_at < ${STALE})
    RETURNING id`
  const stmt = env.DB.prepare(sql)
  const row = await (runId ? stmt.bind(runId) : stmt).first<{ id: number }>()
  return row?.id ?? null
}

export async function kickLab(env: Bindings, runId: number): Promise<boolean> {
  return (await claimStale(env, runId)) !== null
}

/** Cron: a closed tab must not stop a run. */
export async function resumeStuckLab(env: Bindings): Promise<void> {
  const id = await claimStale(env)
  if (id) await walkLab(env, id)
}

export async function labProgress(
  env: Bindings,
  runId: number,
): Promise<{ status: LabStatus; done: number; total: number; failed: number } | null> {
  return env.DB.prepare(`SELECT status, done, total, failed FROM lab_runs WHERE id = ?`)
    .bind(runId)
    .first<{ status: LabStatus; done: number; total: number; failed: number }>()
}

// ---------- cancel, retry, delete ----------
