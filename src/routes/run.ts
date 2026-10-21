import { Hono, type Context } from "hono"

import { currentUser, masterGuard } from "../auth"
import { enqueueTick, loadCycleView, requestOrigin, startCycle, tickOnce } from "../cycle"
import { notifyNew, pickSources, prefilterAndScore, type SourcePolicy } from "../ingest"
import { SCHEDULE_TIMEZONE, loadSchedule, sanitizeTimes, saveSchedule } from "../schedule"
import { pick } from "../locale"
import type { AppEnv } from "../types"

export const run = new Hono<AppEnv>()

run.get("/api/run", async (c) => c.json(await loadCycleView(c.env)))

function sourcePolicy(c: Context<AppEnv>): SourcePolicy {
  return currentUser(c).role === "master" ? "throttled" : "catch_up"
}

run.post("/api/run", async (c) => {
  const user = currentUser(c)
  const cycle = await startCycle(c.env, requestOrigin(c.req.url), user.id, "manual", sourcePolicy(c))
  enqueueTick(c.env, c.executionCtx)
  return c.json(cycle)
})

run.post("/api/run/tick", async (c) => {
  const more = await tickOnce(c.env)
  if (more) enqueueTick(c.env, c.executionCtx)
  return c.json({ ok: true, more })
})

run.get("/api/run/plan", async (c) => {
  const sources = await pickSources(c.env, sourcePolicy(c))
  return c.json({
    sources: sources.map((source) => ({
      id: source.id,
      label: source.label,
      provider: source.provider,
      tier: source.tier,
    })),
  })
})

run.post("/api/score", async (c) => {
  const body = await c.req.json<{ limit?: number }>().catch(() => ({}) as { limit?: number })
  const limit = Number(body.limit) > 0 ? Number(body.limit) : undefined
  return c.json(await prefilterAndScore(c.env, currentUser(c).id, limit))
})

run.post("/api/notify", async (c) => c.json({ notified: await notifyNew(c.env) }))

run.get("/api/run/schedule", async (c) => {
  const denied = masterGuard(c)
  if (denied) return denied
  return c.json({ ...(await loadSchedule(c.env)), timezone: SCHEDULE_TIMEZONE })
})

run.put("/api/run/schedule", async (c) => {
  const denied = masterGuard(c)
  if (denied) return denied
  const body = await c.req.json<{ enabled?: unknown; times?: unknown }>().catch(() => ({}) as Record<string, unknown>)
  if (typeof body.enabled !== "boolean" || !Array.isArray(body.times)) {
    return c.json({ error: "enabled and times required" }, 400)
  }
  const times = sanitizeTimes(body.times)
  if (times.length !== new Set(body.times).size) return c.json({ error: pick("Time must look like HH:MM", "Время должно быть в формате ЧЧ:ММ") }, 400)
  if (body.enabled && times.length === 0) {
    return c.json({ error: pick("Add at least one start time", "Добавьте хотя бы одно время запуска") }, 400)
  }
  const saved = await saveSchedule(c.env, { enabled: body.enabled, times })
  return c.json({ ...saved, timezone: SCHEDULE_TIMEZONE })
})

const LOG_PAGE_SIZE = 10

run.get("/api/run/log", async (c) => {
  const denied = masterGuard(c)
  if (denied) return denied
  const page = Math.max(1, Math.floor(Number(c.req.query("page") ?? 1)) || 1)
  const [rows, count] = await Promise.all([
    c.env.DB.prepare(
      `SELECT r.id, r.kind, r.status, r.started_at, r.finished_at,
         r.sources, r.found, r.fresh, r.failed, r.scored, r.error, u.name AS user_name,
         COALESCE((SELECT SUM(b.input_tokens) FROM model_batches b WHERE b.run_id = r.id), 0) AS input_tokens,
         COALESCE((SELECT SUM(b.output_tokens) FROM model_batches b WHERE b.run_id = r.id), 0) AS output_tokens
       FROM cycle_runs r
       LEFT JOIN users u ON u.id = r.user_id
       ORDER BY r.id DESC LIMIT ? OFFSET ?`,
    )
      .bind(LOG_PAGE_SIZE, (page - 1) * LOG_PAGE_SIZE)
      .all(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM cycle_runs`).first<{ n: number }>(),
  ])
  return c.json({ runs: rows.results, total: Number(count?.n ?? 0), page, page_size: LOG_PAGE_SIZE })
})

const BATCH_COLUMNS = `b.id, b.kind, b.run_id, b.trigger, b.model, b.started_at, b.finished_at,
  b.requests, b.jobs, b.failed, b.duration_ms, b.input_tokens, b.output_tokens,
  u.name AS user_name, u.role AS user_role`

run.get("/api/model/batches", async (c) => {
  const denied = masterGuard(c)
  if (denied) return denied
  const page = Math.max(1, Math.floor(Number(c.req.query("page") ?? 1)) || 1)
  const [rows, count] = await Promise.all([
    c.env.DB.prepare(
      `SELECT ${BATCH_COLUMNS}
       FROM model_batches b
       LEFT JOIN users u ON u.id = b.user_id
       ORDER BY b.id DESC LIMIT ? OFFSET ?`,
    )
      .bind(LOG_PAGE_SIZE, (page - 1) * LOG_PAGE_SIZE)
      .all(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM model_batches`).first<{ n: number }>(),
  ])
  return c.json({ batches: rows.results, total: Number(count?.n ?? 0), page, page_size: LOG_PAGE_SIZE })
})

run.get("/api/model/batches/:id", async (c) => {
  const denied = masterGuard(c)
  if (denied) return denied
  const id = Number(c.req.param("id"))
  const batch = await c.env.DB.prepare(
    `SELECT ${BATCH_COLUMNS}
     FROM model_batches b
     LEFT JOIN users u ON u.id = b.user_id
     WHERE b.id = ?`,
  )
    .bind(id)
    .first()
  if (!batch) return c.json({ error: "not found" }, 404)
  const requests = await c.env.DB.prepare(
    `SELECT id, model, started_at, finished_at, duration_ms, jobs,
       input_tokens, output_tokens, thought_tokens, ok, error
     FROM model_requests WHERE batch_id = ? ORDER BY id`,
  )
    .bind(id)
    .all()
  return c.json({ batch, requests: requests.results })
})

run.get("/api/runs", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT r.*, s.label, s.provider FROM source_runs r
     JOIN sources s ON s.id = r.source_id
     ORDER BY r.id DESC LIMIT 50`,
  ).all()
  return c.json({ runs: rows.results })
})
