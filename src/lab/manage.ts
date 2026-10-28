import { runBatch } from "../db"
import { pick } from "../locale"
import type { Bindings } from "../types"
import { recount } from "./engine"
import { LIVE, type LabResult, type LabRunView, type LabStatus, NOT_FOUND, activeRun, bad, busy } from "./shared"
import { loadRunView } from "./views"

export async function cancelLabRun(env: Bindings, id: number): Promise<LabResult<{ run: LabRunView }>> {
  const stopped = await env.DB.prepare(
    `UPDATE lab_runs SET status = 'cancelled', finished_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ? AND ${LIVE}`,
  )
    .bind(id)
    .run()
  if (!Number(stopped.meta.changes)) {
    const exists = await env.DB.prepare(`SELECT id FROM lab_runs WHERE id = ?`).bind(id).first()
    return exists ? { status: 409, body: { error: pick("The run has already finished", "Прогон уже завершён") } } : NOT_FOUND
  }
  await runBatch(env, [
    env.DB.prepare(`UPDATE lab_trials SET status = 'cancelled' WHERE lab_run_id = ? AND status = 'pending'`).bind(id),
    recount(env, id),
  ])
  return { status: 200, body: { run: (await loadRunView(env, id))! } }
}

/** Failed trials go back to the queue with fresh attempts; a finished run reopens for them. */
export async function retryLabRun(
  env: Bindings,
  id: number,
  trialIds: unknown,
): Promise<LabResult<{ run: LabRunView }>> {
  const run = await env.DB.prepare(`SELECT status FROM lab_runs WHERE id = ?`).bind(id).first<{ status: LabStatus }>()
  if (!run) return NOT_FOUND
  if (run.status !== "queued" && run.status !== "running") {
    const active = await activeRun(env)
    if (active && active !== id) return busy(active)
  }
  const ids = Array.isArray(trialIds) ? trialIds.map(Number).filter((value) => Number.isInteger(value)) : []
  if (Array.isArray(trialIds) && ids.length === 0) return bad(pick("No failed trials", "Нет упавших попыток"))
  const reset = await env.DB.prepare(
    `UPDATE lab_trials SET status = 'pending', attempts = 0, score = NULL, reason = NULL, flags = NULL,
       raw_response = NULL, error_code = NULL, error = NULL, input_tokens = NULL, output_tokens = NULL,
       thought_tokens = NULL, duration_ms = NULL, claimed_at = NULL, finished_at = NULL
     WHERE lab_run_id = ? AND status = 'failed' ${ids.length ? `AND id IN (SELECT value FROM json_each(?))` : ""}`,
  )
    .bind(id, ...(ids.length ? [JSON.stringify(ids)] : []))
    .run()
  if (!Number(reset.meta.changes)) return bad(pick("No failed trials", "Нет упавших попыток"))
  // The recount stamps updated_at, so it goes first: a reopened run has to look stale for the kick that follows.
  await runBatch(env, [
    recount(env, id),
    env.DB.prepare(
      `UPDATE lab_runs SET
         status = CASE WHEN ${LIVE} THEN status ELSE 'queued' END,
         hops = CASE WHEN ${LIVE} THEN hops ELSE 0 END,
         updated_at = CASE WHEN ${LIVE} THEN updated_at ELSE NULL END,
         finished_at = NULL, error = NULL
       WHERE id = ?`,
    ).bind(id),
  ])
  return { status: 200, body: { run: (await loadRunView(env, id))! } }
}

export async function dropRun(env: Bindings, id: number): Promise<void> {
  await runBatch(env, [
    env.DB.prepare(`DELETE FROM lab_trials WHERE lab_run_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM lab_candidates WHERE lab_run_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM lab_jobs WHERE lab_run_id = ?`).bind(id),
    env.DB.prepare(`UPDATE lab_runs SET cloned_from = NULL WHERE cloned_from = ?`).bind(id),
    env.DB.prepare(`DELETE FROM lab_runs WHERE id = ?`).bind(id),
  ])
}

/** model_batches rows stay: the money was spent either way. */
export async function deleteLabRun(env: Bindings, id: number): Promise<LabResult<{ ok: true }>> {
  const run = await env.DB.prepare(`SELECT status FROM lab_runs WHERE id = ?`).bind(id).first<{ status: LabStatus }>()
  if (!run) return NOT_FOUND
  if (run.status === "queued" || run.status === "running") {
    return {
      status: 409,
      body: { error: pick("A running run cannot be deleted — cancel it first", "Идущий прогон нельзя удалить — сначала отмените его") },
    }
  }
  await dropRun(env, id)
  return { status: 200, body: { ok: true } }
}
