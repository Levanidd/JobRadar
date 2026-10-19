import { runBatch } from "./db"
import type { ModelCall, ScoringConfig } from "./scoring"
import type { Bindings } from "./types"

export type BatchKind = "cycle" | "score" | "source" | "rescore" | "job" | "check" | "lab"

export type UsageContext = {
  kind: BatchKind
  userId: number | null
  trigger: "manual" | "auto"
  /** A cycle scores one user over many hops; they all land in the same batch. */
  runId?: number | null
  /** A lab run keeps the batch it opened and adds every later hop to it. */
  batchId?: number | null
}

const ADD_TO_BATCH = `started_at = MIN(started_at, ?), finished_at = MAX(finished_at, ?), model = ?,
  requests = requests + ?, jobs = jobs + ?, failed = failed + ?, duration_ms = duration_ms + ?,
  input_tokens = input_tokens + ?, output_tokens = output_tokens + ?`

function totalsBinds(calls: ModelCall[]): Array<string | number> {
  const sum = totals(calls)
  return [sum.started, sum.finished, sum.model, calls.length, sum.jobs, sum.failed, sum.duration, sum.input, sum.output]
}

function totals(calls: ModelCall[]) {
  return {
    started: calls.reduce((min, call) => (call.started_at < min ? call.started_at : min), calls[0].started_at),
    finished: calls.reduce((max, call) => (call.finished_at > max ? call.finished_at : max), calls[0].finished_at),
    jobs: calls.reduce((sum, call) => sum + call.jobs, 0),
    failed: calls.filter((call) => !call.ok).length,
    duration: calls.reduce((sum, call) => sum + call.duration_ms, 0),
    input: calls.reduce((sum, call) => sum + call.input_tokens, 0),
    output: calls.reduce((sum, call) => sum + call.output_tokens, 0),
    model: calls[calls.length - 1].model,
  }
}

async function batchId(env: Bindings, context: UsageContext, calls: ModelCall[]): Promise<number | null> {
  const sum = totals(calls)
  if (context.batchId) {
    const existing = await env.DB.prepare(`UPDATE model_batches SET ${ADD_TO_BATCH} WHERE id = ? RETURNING id`)
      .bind(...totalsBinds(calls), context.batchId)
      .first<{ id: number }>()
    if (existing) return existing.id
  }
  if (context.runId) {
    const existing = await env.DB.prepare(
      `UPDATE model_batches SET ${ADD_TO_BATCH} WHERE run_id = ? AND user_id IS ? RETURNING id`,
    )
      .bind(...totalsBinds(calls), context.runId, context.userId)
      .first<{ id: number }>()
    if (existing) return existing.id
  }
  const created = await env.DB.prepare(
    `INSERT INTO model_batches
       (kind, run_id, user_id, trigger, model, started_at, finished_at,
        requests, jobs, failed, duration_ms, input_tokens, output_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id`,
  )
    .bind(
      context.kind,
      context.runId ?? null,
      context.userId,
      context.trigger,
      sum.model,
      sum.started,
      sum.finished,
      calls.length,
      sum.jobs,
      sum.failed,
      sum.duration,
      sum.input,
      sum.output,
    )
    .first<{ id: number }>()
  return created?.id ?? null
}

/** Returns the batch the calls went into, so a caller spanning many hops can keep adding to it. */
export async function recordCalls(env: Bindings, context: UsageContext, calls: ModelCall[]): Promise<number | null> {
  if (calls.length === 0) return context.batchId ?? null
  const id = await batchId(env, context, calls)
  if (!id) return null
  await runBatch(
    env,
    calls.map((call) =>
      env.DB.prepare(
        `INSERT INTO model_requests
           (batch_id, model, started_at, finished_at, duration_ms, jobs,
            input_tokens, output_tokens, thought_tokens, ok, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        call.model,
        call.started_at,
        call.finished_at,
        call.duration_ms,
        call.jobs,
        call.input_tokens,
        call.output_tokens,
        call.thought_tokens,
        call.ok ? 1 : 0,
        call.error,
      ),
    ),
  )
  return id
}

/**
 * Runs `work` with a config that remembers every model call, then writes them
 * down even if the work failed. A broken log must not cost the scoring result.
 */
export async function withUsage<T>(
  env: Bindings,
  context: UsageContext,
  config: ScoringConfig,
  work: (config: ScoringConfig) => Promise<T>,
): Promise<T> {
  const calls: ModelCall[] = []
  try {
    return await work({ ...config, onCall: (call) => calls.push(call) })
  } finally {
    await recordCalls(env, context, calls).catch((error) => console.error("usage log failed", error))
  }
}
