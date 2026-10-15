import { message } from "./errors"
import { notifyNew, pickSources, prefilterAndScore, runSourceStep, type SourcePolicy } from "./ingest"
import type { Bindings, SourceRow } from "./types"
import type { UsageContext } from "./usage"

const SCORE_CHUNK = 30
const MAX_HOPS = 1000

export type CyclePhase = "sources" | "scoring" | "digest"
export type CycleStatus = "idle" | "running" | "done" | "error"
export type CycleKind = "manual" | "auto"

type Planned = { id: number; label: string }

type CycleRow = {
  status: CycleStatus
  phase: CyclePhase
  source_ids: string
  cursor: number
  total: number
  source_total: number
  done: number
  current_label: string | null
  current_id: number | null
  found: number
  fresh: number
  failed: number
  scored: number
  notified: number
  hops: number
  chunk_offset: number
  chunk_started_at: string | null
  error: string | null
  origin: string | null
  user_id: number | null
  score_queue: string
  run_id: number | null
  started_at: string | null
  updated_at: string | null
  finished_at: string | null
}

export type CycleView = {
  status: CycleStatus
  phase: CyclePhase
  done: number
  total: number
  source_total: number
  current: string
  current_id: number | null
  found: number
  fresh: number
  failed: number
  scored: number
  notified: number
  error: string | null
  updated_at: string | null
}

function planned(raw: string): Planned[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is Planned =>
        Boolean(item) && typeof item === "object" && typeof (item as Planned).id === "number",
    )
  } catch {
    return []
  }
}

function view(row: CycleRow): CycleView {
  return {
    status: row.status,
    phase: row.phase,
    done: row.done,
    total: row.total,
    source_total: row.source_total,
    current: row.current_label ?? "",
    current_id: row.current_id,
    found: row.found,
    fresh: row.fresh,
    failed: row.failed,
    scored: row.scored,
    notified: row.notified,
    error: row.error,
    updated_at: row.updated_at,
  }
}

async function loadRow(env: Bindings): Promise<CycleRow | null> {
  return env.DB.prepare(`SELECT * FROM cycles WHERE id = 1`).first<CycleRow>()
}

export async function loadCycleView(env: Bindings): Promise<CycleView> {
  const row = await loadRow(env)
  if (!row) {
    return {
      status: "idle",
      phase: "sources",
      done: 0,
      total: 0,
      source_total: 0,
      current: "",
      current_id: null,
      found: 0,
      fresh: 0,
      failed: 0,
      scored: 0,
      notified: 0,
      error: null,
      updated_at: null,
    }
  }
  return view(row)
}

/** Copies the finished cycle's outcome onto its log entry. */
async function closeRun(env: Bindings): Promise<void> {
  await env.DB.prepare(
    `UPDATE cycle_runs SET
       status = c.status, finished_at = c.finished_at, sources = c.source_total,
       found = c.found, fresh = c.fresh, failed = c.failed, scored = c.scored, error = c.error
     FROM (SELECT * FROM cycles WHERE id = 1) AS c
     WHERE cycle_runs.id = c.run_id AND cycle_runs.status = 'running'`,
  ).run()
}

export async function failCycle(env: Bindings, error: unknown): Promise<void> {
  const failed = await env.DB.prepare(
    `UPDATE cycles SET status = 'error', error = ?, current_label = NULL, current_id = NULL,
       updated_at = datetime('now'), finished_at = datetime('now')
     WHERE id = 1 AND status = 'running'`,
  )
    .bind(message(error))
    .run()
  if (Number(failed.meta.changes)) await closeRun(env)
}

/** Lines a user up for scoring in the live cycle, unless they are already being scored or waiting. */
async function queueScoring(env: Bindings, userId: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE cycles SET score_queue = json_insert(score_queue, '$[#]', CAST(?1 AS INTEGER))
     WHERE id = 1 AND status = 'running' AND user_id IS NOT ?1
       AND NOT EXISTS (SELECT 1 FROM json_each(cycles.score_queue) WHERE value = ?1)`,
  )
    .bind(userId)
    .run()
}

/**
 * Starts a cycle, or leaves a live one alone so a second click / a stale poll
 * can re-kick the chain without wiping progress.
 */
export async function startCycle(
  env: Bindings,
  origin?: string,
  userId?: number,
  kind: CycleKind = "manual",
  policy: SourcePolicy = "throttled",
): Promise<CycleView> {
  const current = await loadRow(env)
  if (current?.status === "running") {
    if (origin && !current.origin) {
      await env.DB.prepare(`UPDATE cycles SET origin = ? WHERE id = 1`).bind(origin).run()
    }
    if (userId) await queueScoring(env, userId)
    return view(current)
  }

  const sources = await pickSources(env, policy)
  const items = sources.map((source) => ({ id: source.id, label: source.label }))
  const phase: CyclePhase = items.length === 0 ? "scoring" : "sources"
  const logged = await env.DB.prepare(
    `INSERT INTO cycle_runs (kind, user_id, sources) VALUES (?, ?, ?) RETURNING id`,
  )
    .bind(kind, userId ?? null, items.length)
    .first<{ id: number }>()
  await env.DB.prepare(
    `UPDATE cycles SET
       status = 'running', phase = ?, source_ids = ?, cursor = 0,
       total = ?, source_total = ?, done = 0,
       current_label = NULL, current_id = NULL,
       found = 0, fresh = 0, failed = 0, scored = 0, notified = 0,
       hops = 0, chunk_offset = 0, chunk_started_at = NULL,
       error = NULL, origin = ?, user_id = ?, score_queue = '[]', run_id = ?,
       started_at = datetime('now'), updated_at = datetime('now'), finished_at = NULL
     WHERE id = 1`,
  )
    .bind(
      phase,
      JSON.stringify(items),
      items.length,
      items.length,
      origin ?? current?.origin ?? null,
      userId ?? null,
      logged?.id ?? null,
    )
    .run()

  const row = await loadRow(env)
  return row ? view(row) : await loadCycleView(env)
}

/** Closes the cycle, or returns false when someone joined the queue after scoring ended. */
async function finish(env: Bindings, notified: number): Promise<boolean> {
  const closed = await env.DB.prepare(
    `UPDATE cycles SET status = 'done', phase = 'digest', notified = ?,
       current_label = NULL, current_id = NULL,
       updated_at = datetime('now'), finished_at = datetime('now')
     WHERE id = 1 AND json_array_length(score_queue) = 0`,
  )
    .bind(notified)
    .run()
  if (Number(closed.meta.changes)) {
    await closeRun(env)
    return true
  }
  await env.DB.prepare(
    `UPDATE cycles SET phase = 'scoring',
       user_id = json_extract(score_queue, '$[0]'), score_queue = json_remove(score_queue, '$[0]'),
       updated_at = datetime('now')
     WHERE id = 1`,
  ).run()
  return false
}

/** Only the scheduled run's own user is "auto"; anyone who queued up behind it clicked the button. */
async function cycleUsage(env: Bindings, runId: number | null, userId: number): Promise<UsageContext> {
  const run = runId
    ? await env.DB.prepare(`SELECT kind, user_id FROM cycle_runs WHERE id = ?`)
        .bind(runId)
        .first<{ kind: CycleKind; user_id: number | null }>()
    : null
  const trigger = run?.kind === "auto" && run.user_id === userId ? "auto" : "manual"
  return { kind: "cycle", userId, trigger, runId }
}

async function advance(env: Bindings, row: CycleRow): Promise<boolean> {
  if (row.phase === "sources") {
    const item = planned(row.source_ids)[row.cursor]
    if (!item) {
      await env.DB.prepare(
        `UPDATE cycles SET phase = 'scoring', done = 0, total = 0,
           current_label = NULL, current_id = NULL,
           chunk_offset = 0, chunk_started_at = NULL, updated_at = datetime('now')
         WHERE id = 1`,
      ).run()
      return true
    }
    await env.DB.prepare(
      `UPDATE cycles SET current_label = ?, current_id = ?, updated_at = datetime('now') WHERE id = 1`,
    )
      .bind(item.label, item.id)
      .run()

    const source = await env.DB.prepare(`SELECT * FROM sources WHERE id = ?`).bind(item.id).first<SourceRow>()
    const run = source
      ? await runSourceStep(env, source, row.chunk_offset ?? 0, row.chunk_started_at)
      : { ok: false, jobs_found: 0, jobs_new: 0, more: false, nextOffset: 0, runStart: row.chunk_started_at ?? "" }

    if (run.ok && run.more) {
      await env.DB.prepare(
        `UPDATE cycles SET
           chunk_offset = ?, chunk_started_at = ?,
           found = found + ?, fresh = fresh + ?,
           updated_at = datetime('now')
         WHERE id = 1`,
      )
        .bind(run.nextOffset, run.runStart, run.jobs_found, run.jobs_new)
        .run()
      return true
    }

    await env.DB.prepare(
      `UPDATE cycles SET
         cursor = cursor + 1, done = done + 1,
         chunk_offset = 0, chunk_started_at = NULL,
         found = found + ?, fresh = fresh + ?, failed = failed + ?,
         current_label = NULL, current_id = NULL, updated_at = datetime('now')
       WHERE id = 1`,
    )
      .bind(run.jobs_found, run.jobs_new, run.ok ? 0 : 1)
      .run()
    return true
  }

  if (row.phase === "scoring") {
    const userId = row.user_id
    const step = userId
      ? await prefilterAndScore(env, userId, SCORE_CHUNK, await cycleUsage(env, row.run_id, userId))
      : { scored: 0, remaining: 0, more: false }
    const scored = row.scored + step.scored
    if (step.more) {
      await env.DB.prepare(
        `UPDATE cycles SET scored = ?, done = ?, total = ?,
           current_label = NULL, current_id = NULL, updated_at = datetime('now')
         WHERE id = 1`,
      )
        .bind(scored, scored, scored + step.remaining)
        .run()
      return true
    }
    // This user is done: hand the scoring phase to the next one in the queue,
    // or move on to the digest when nobody is waiting.
    await env.DB.prepare(
      `UPDATE cycles SET scored = ?1, done = ?1, total = ?1,
         phase = CASE WHEN json_array_length(score_queue) > 0 THEN 'scoring' ELSE 'digest' END,
         user_id = CASE WHEN json_array_length(score_queue) > 0 THEN json_extract(score_queue, '$[0]') ELSE user_id END,
         score_queue = CASE WHEN json_array_length(score_queue) > 0 THEN json_remove(score_queue, '$[0]') ELSE score_queue END,
         current_label = NULL, current_id = NULL, updated_at = datetime('now')
       WHERE id = 1`,
    )
      .bind(scored)
      .run()
    return true
  }

  const notified = await notifyNew(env)
  return !(await finish(env, notified))
}

/** One source, one scoring chunk, or the digest. Returns whether another hop is needed. */
export async function tickOnce(env: Bindings): Promise<boolean> {
  const row = await loadRow(env)
  if (!row || row.status !== "running") return false
  if (row.hops >= MAX_HOPS) {
    await failCycle(env, "cycle exceeded hop limit")
    return false
  }

  const cas = await env.DB.prepare(
    `UPDATE cycles SET hops = hops + 1, updated_at = datetime('now')
     WHERE id = 1 AND status = 'running' AND hops = ?`,
  )
    .bind(row.hops)
    .run()
  if (!Number(cas.meta.changes)) return false

  const fresh = await loadRow(env)
  if (!fresh || fresh.status !== "running") return false

  try {
    return await advance(env, fresh)
  } catch (error) {
    await failCycle(env, error)
    return false
  }
}

/** Walk the rest of the cycle after the HTTP response, so the tab can close. */
export async function walkCycle(env: Bindings): Promise<void> {
  try {
    while (await tickOnce(env)) {
      /* one source, scoring chunk, or digest per hop */
    }
  } catch (error) {
    await failCycle(env, error)
  }
}

export function enqueueTick(env: Bindings, ctx: { waitUntil(promise: Promise<unknown>): void }): void {
  ctx.waitUntil(walkCycle(env))
}

/**
 * Cloudflare kills waitUntil around 30s. Cron runs every minute; 45s of
 * silence skipped that next tick (age ~32s) and the cycle sat idle a
 * whole extra minute. 25s is just above a 20s fetch hop, so a live hop
 * is left alone and the following cron always continues.
 */
export async function resumeStuckCycle(env: Bindings): Promise<void> {
  const claimed = await env.DB.prepare(
    `UPDATE cycles SET updated_at = datetime('now')
     WHERE id = 1 AND status = 'running'
       AND updated_at < datetime('now', '-25 seconds')`,
  ).run()
  if (!Number(claimed.meta.changes)) return
  await walkCycle(env)
}

export function requestOrigin(url: string): string {
  return new URL(url).origin
}
