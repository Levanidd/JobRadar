import { Hono, type Context } from "hono"

import { currentUser, masterGuard } from "../auth"
import {
  cancelLabRun,
  cloneLabRun,
  createLabRun,
  deleteLabRun,
  kickLab,
  labCsv,
  labProgress,
  listLabRuns,
  loadLabJob,
  loadLabRun,
  previewLab,
  retryLabRun,
  walkLab,
} from "../lab"
import type { AppEnv } from "../types"

export const lab = new Hono<AppEnv>()

// The lab spends provider money and reads every user's scores, so it is the master's alone.
for (const path of ["/api/lab", "/api/lab/*"]) {
  lab.use(path, async (c, next) => masterGuard(c) ?? (await next()))
}

async function readBody(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  const parsed: unknown = await c.req.json().catch(() => null)
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
}

function runId(c: Context<AppEnv>): number | null {
  const id = Number(c.req.param("id"))
  return Number.isInteger(id) && id > 0 ? id : null
}

function walk(c: Context<AppEnv>, id: number): void {
  c.executionCtx.waitUntil(walkLab(c.env, id))
}

lab.post("/api/lab/preview", async (c) => {
  const result = await previewLab(c.env, currentUser(c), await readBody(c))
  return c.json(result.body, result.status)
})

lab.post("/api/lab/runs", async (c) => {
  const result = await createLabRun(c.env, currentUser(c), await readBody(c))
  if ("run" in result.body) walk(c, result.body.run.id)
  return c.json(result.body, result.status)
})

lab.get("/api/lab/runs", async (c) => {
  const page = Math.max(1, Math.floor(Number(c.req.query("page") ?? 1)) || 1)
  return c.json(await listLabRuns(c.env, page))
})

lab.get("/api/lab/runs/:id", async (c) => {
  const id = runId(c)
  const detail = id ? await loadLabRun(c.env, id) : null
  return detail ? c.json(detail) : c.json({ error: "not found" }, 404)
})

lab.get("/api/lab/runs/:id/jobs/:jobId", async (c) => {
  const id = runId(c)
  const detail = id ? await loadLabJob(c.env, id, c.req.param("jobId")) : null
  return detail ? c.json(detail) : c.json({ error: "not found" }, 404)
})

/** The open tab's safety net: starts a walker only when nobody has moved the run for a while. */
lab.post("/api/lab/runs/:id/tick", async (c) => {
  const id = runId(c)
  const progress = id ? await labProgress(c.env, id) : null
  if (!id || !progress) return c.json({ error: "not found" }, 404)
  const kicked = await kickLab(c.env, id)
  if (kicked) walk(c, id)
  const more = progress.status === "queued" || progress.status === "running"
  return c.json({ ok: true, more, kicked, progress })
})

lab.post("/api/lab/runs/:id/cancel", async (c) => {
  const id = runId(c)
  if (!id) return c.json({ error: "not found" }, 404)
  const result = await cancelLabRun(c.env, id)
  return c.json(result.body, result.status)
})

lab.post("/api/lab/runs/:id/retry", async (c) => {
  const id = runId(c)
  if (!id) return c.json({ error: "not found" }, 404)
  const result = await retryLabRun(c.env, id, (await readBody(c)).trial_ids)
  if (result.status === 200 && (await kickLab(c.env, id))) walk(c, id)
  return c.json(result.body, result.status)
})

lab.post("/api/lab/runs/:id/clone", async (c) => {
  const id = runId(c)
  if (!id) return c.json({ error: "not found" }, 404)
  const result = await cloneLabRun(c.env, currentUser(c), id, await readBody(c))
  if ("run" in result.body) walk(c, result.body.run.id)
  return c.json(result.body, result.status)
})

lab.get("/api/lab/runs/:id/export.csv", async (c) => {
  const id = runId(c)
  const csv = id ? await labCsv(c.env, id) : null
  if (!id || csv === null) return c.json({ error: "not found" }, 404)
  return c.body(csv, 200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="lab-run-${id}.csv"`,
  })
})

lab.delete("/api/lab/runs/:id", async (c) => {
  const id = runId(c)
  if (!id) return c.json({ error: "not found" }, 404)
  const result = await deleteLabRun(c.env, id)
  return c.json(result.body, result.status)
})
