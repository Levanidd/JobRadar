import { Hono } from "hono"

import { currentUser, masterGuard } from "../auth"
import { message } from "../errors"
import { placeholders } from "../db"
import { createManualJob, scoreJobsByIds, scoreOneJob, setPrimaryListing } from "../ingest"
import { backfillJobTexts, backfillTextHashes, JOB_DESCRIPTION, JOB_TEXT_JOIN } from "../job-text"
import { QuotaError } from "../quota"
import type { AppEnv } from "../types"
import { JOB_COLUMNS, JOB_SOURCE, appliedFilters, jobFilters, jobOrder, jobsFromUser, userJobsHint } from "./job-query"

export const jobs = new Hono<AppEnv>()

const STATUSES = ["new", "notified", "saved", "applied", "interview", "rejected", "ignored", "off_profile"]

/** Empty clears the link; anything that is not an http(s) URL is refused, since the card opens it. */
function cleanCvUrl(raw: unknown): string | null | false {
  if (raw === null) return null
  if (typeof raw !== "string") return false
  const value = raw.trim()
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : false
  } catch {
    return false
  }
}

type DuplicateListing = {
  id: string
  url: string
  title: string
  company: string
  source_label: string
  kind: string
  first_seen_at: string
  duplicate_of: string | null
}

async function loadJobDetail(env: AppEnv["Bindings"], userId: number, id: string) {
  const row = await env.DB.prepare(
    `SELECT ${JOB_COLUMNS}, ${JOB_DESCRIPTION} AS description, uj.notes, uj.cv_url, uj.claude_comment, s.tier, s.label as source_label
     ${JOB_SOURCE}
     ${JOB_TEXT_JOIN}
     WHERE j.id = ?`,
  )
    .bind(userId, id)
    .first<Record<string, unknown> & { duplicate_of: string | null }>()
  if (!row) return null

  const root = row.duplicate_of || id
  const group = await env.DB.prepare(
    `SELECT j.id, j.url, j.title, j.company, j.first_seen_at, j.duplicate_of,
            s.label as source_label, s.kind
     FROM jobs j JOIN sources s ON s.id = j.source_id
     WHERE j.id = ? OR j.duplicate_of = ?
     ORDER BY j.duplicate_of IS NULL DESC, j.first_seen_at ASC`,
  )
    .bind(root, root)
    .all<DuplicateListing>()

  const stages = await loadStages(env, userId, id)
  const duplicates = group.results.map((item) => ({
    id: item.id,
    url: item.url,
    title: item.title,
    company: item.company,
    source_label: item.source_label,
    kind: item.kind,
    first_seen_at: item.first_seen_at,
    primary: !item.duplicate_of,
  }))
  return { ...row, duplicates, stages }
}

type Stage = { id: number; title: string; happened_on: string | null }

const STAGE_COLUMNS = "id, title, happened_on"

async function loadStages(env: AppEnv["Bindings"], userId: number, jobId: string): Promise<Stage[]> {
  const rows = await env.DB.prepare(
    `SELECT ${STAGE_COLUMNS} FROM interview_stages
     WHERE user_id = ? AND job_id = ?
     ORDER BY happened_on IS NULL, happened_on, id`,
  )
    .bind(userId, jobId)
    .all<Stage>()
  return rows.results
}

/** A stage needs a name; the date is optional but has to be a real day when given. */
function readStage(body: Record<string, unknown>, partial: boolean): { title?: string; happened_on?: string | null } | string {
  const out: { title?: string; happened_on?: string | null } = {}
  if (body.title !== undefined || !partial) {
    const title = typeof body.title === "string" ? body.title.trim() : ""
    if (!title) return "title required"
    out.title = title.slice(0, 200)
  }
  if (body.happened_on !== undefined) {
    const day = body.happened_on
    if (day === null || day === "") out.happened_on = null
    else if (typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(day))) {
      out.happened_on = day
    } else return "happened_on must be YYYY-MM-DD"
  }
  if (partial && out.title === undefined && out.happened_on === undefined) return "nothing to update"
  return out
}

jobs.get("/api/applied/companies", async (c) => {
  const userId = currentUser(c).id
  const { clauses, binds } = await appliedFilters(c, { company: false })
  const rows = await c.env.DB.prepare(
    `SELECT j.company AS company, COUNT(*) AS jobs
     FROM user_jobs uj
     CROSS JOIN jobs j ON j.id = uj.job_id
     WHERE uj.user_id = ? AND ${clauses} AND j.company != ''
     GROUP BY j.company
     ORDER BY j.company COLLATE NOCASE`,
  )
    .bind(userId, ...binds)
    .all<{ company: string; jobs: number }>()
  return c.json({ companies: rows.results })
})

jobs.get("/api/applied", async (c) => {
  const userId = currentUser(c).id
  const { clauses, binds } = await appliedFilters(c)
  const rows = await c.env.DB.prepare(
    `SELECT ${JOB_COLUMNS}, uj.notes, s.tier, s.label AS source_label
     FROM user_jobs uj
     CROSS JOIN jobs j ON j.id = uj.job_id
     JOIN sources s ON s.id = j.source_id
     WHERE uj.user_id = ? AND ${clauses}
     ORDER BY uj.applied_at DESC
     LIMIT 200`,
  )
    .bind(userId, ...binds)
    .all()
  return c.json({ jobs: rows.results })
})

jobs.post("/api/applied", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>)
  const text = (key: string) => (typeof body[key] === "string" ? (body[key] as string) : undefined)
  try {
    const job = await createManualJob(
      c.env,
      {
        title: String(body.title ?? ""),
        company: String(body.company ?? ""),
        url: String(body.url ?? ""),
        location: text("location"),
        description: text("description"),
        notes: text("notes"),
        salary_min: body.salary_min,
        salary_max: body.salary_max,
        salary_currency: text("salary_currency"),
        status: text("status"),
        applied_at: text("applied_at"),
      },
      currentUser(c).id,
    )
    return c.json({ job }, 201)
  } catch (error) {
    return c.json({ error: message(error) }, 400)
  }
})

function listedJobs(sourceScoped: boolean): string {
  const hint = sourceScoped ? "" : " INDEXED BY idx_jobs_live"
  return `FROM jobs j${hint}
  JOIN sources s ON s.id = j.source_id
  LEFT JOIN user_jobs uj ON uj.job_id = j.id AND uj.user_id = ?`
}

const PAGE_DEFAULT = 50
const PAGE_MAX = 99

function pageBounds(rawLimit: string | undefined, rawOffset: string | undefined): { limit: number; offset: number } {
  const limitValue = Number(rawLimit ?? PAGE_DEFAULT)
  const offsetValue = Number(rawOffset ?? 0)
  const limit = Number.isFinite(limitValue) && limitValue >= 1 ? Math.min(PAGE_MAX, Math.floor(limitValue)) : PAGE_DEFAULT
  const offset = Number.isFinite(offsetValue) && offsetValue >= 0 ? Math.floor(offsetValue) : 0
  return { limit, offset }
}

jobs.get("/api/jobs", async (c) => {
  const userId = currentUser(c).id
  const sourceScoped = Boolean(Number(c.req.query("source_id") ?? 0))
  const { limit, offset } = pageBounds(c.req.query("limit"), c.req.query("offset"))
  const fromUser = jobsFromUser(c)
  const { clauses, binds } = await jobFilters(c, true, fromUser)
  // The source table is only needed when the tier filter reads it.
  const sourceJoin = c.req.query("tier") ? "JOIN sources s ON s.id = j.source_id" : ""
  // A score, a verdict, or a "yes" mark means the row lives on user_jobs.
  // Anything that still includes postings nobody has touched starts from jobs.
  const ordered = await c.env.DB.prepare(
    fromUser
      ? `SELECT j.id
         FROM user_jobs uj${userJobsHint(c)}
         CROSS JOIN jobs j ON j.id = uj.job_id
         ${sourceJoin}
         WHERE uj.user_id = ? AND ${clauses}
         ORDER BY ${jobOrder(c)}
         LIMIT ? OFFSET ?`
      : `SELECT j.id
         FROM jobs j${sourceScoped ? "" : " INDEXED BY idx_jobs_list_cover"}
         ${sourceJoin}
         LEFT JOIN user_jobs uj INDEXED BY idx_user_jobs_list ON uj.job_id = j.id AND uj.user_id = ?
         WHERE ${clauses}
         ORDER BY ${jobOrder(c)}
         LIMIT ? OFFSET ?`,
  )
    .bind(userId, ...binds, limit, offset)
    .all<{ id: string }>()
  const ids = ordered.results.map((row) => row.id)
  const hasMore = ids.length === limit
  const nextOffset = offset + ids.length
  if (ids.length === 0) return c.json({ jobs: [], has_more: false, next_offset: nextOffset })

  const loaded = await c.env.DB.prepare(
    `SELECT ${JOB_COLUMNS}, s.tier, s.label as source_label
     FROM jobs j
     JOIN sources s ON s.id = j.source_id
     LEFT JOIN user_jobs uj ON uj.job_id = j.id AND uj.user_id = ?
     WHERE j.id IN (${placeholders(ids.length)})`,
  )
    .bind(userId, ...ids)
    .all<{ id: string }>()
  const byId = new Map(loaded.results.map((row) => [row.id, row]))
  return c.json({
    jobs: ids.flatMap((id) => { const row = byId.get(id); return row ? [row] : [] }),
    has_more: hasMore,
    next_offset: nextOffset,
  })
})

/** Fills jobs.text_hash from job_texts. Master only. Call again with the returned rowid until it is 0. */
jobs.post("/api/jobs/backfill-text-hashes", async (c) => {
  const denied = masterGuard(c)
  if (denied) return denied
  const after = Number(c.req.query("after") ?? 0)
  const limit = Number(c.req.query("limit") ?? 500)
  if (!Number.isFinite(after) || after < 0) return c.json({ error: "after must be a rowid" }, 400)
  if (!Number.isFinite(limit) || limit < 1) return c.json({ error: "limit must be at least 1" }, 400)
  return c.json(await backfillTextHashes(c.env, after, limit))
})
jobs.post("/api/jobs/backfill-texts", async (c) => {
  const denied = masterGuard(c)
  if (denied) return denied
  const after = Number(c.req.query("after") ?? 0)
  const limit = Number(c.req.query("limit") ?? 50)
  if (!Number.isFinite(after) || after < 0) return c.json({ error: "after must be a rowid" }, 400)
  if (!Number.isFinite(limit) || limit < 1) return c.json({ error: "limit must be at least 1" }, 400)
  const result = await backfillJobTexts(c.env, after, limit)
  return c.json(result)
})

jobs.get("/api/jobs/companies", async (c) => {
  const userId = currentUser(c).id
  const fromUser = jobsFromUser(c)
  const { clauses, binds } = await jobFilters(c, false, fromUser)
  const q = (c.req.query("q") ?? "").trim().toLowerCase().replace(/[%_\\]/g, "").slice(0, 40)
  const prefix = q ? ` AND j.company_key LIKE (? || '%')` : ""
  const limit = q ? " LIMIT 20" : ""
  const sourceJoin = "JOIN sources s ON s.id = j.source_id"
  const rows = await c.env.DB.prepare(
    fromUser
      ? `SELECT j.company_key, MIN(j.company) AS company, COUNT(*) AS jobs
         FROM user_jobs uj${userJobsHint(c)}
         CROSS JOIN jobs j ON j.id = uj.job_id
         ${sourceJoin}
         WHERE uj.user_id = ? AND ${clauses}${prefix}
         GROUP BY j.company_key
         ORDER BY company COLLATE NOCASE${limit}`
      : `SELECT j.company_key, MIN(j.company) AS company, COUNT(*) AS jobs
         ${listedJobs(Boolean(Number(c.req.query("source_id") ?? 0)))}
         WHERE ${clauses}${prefix}
         GROUP BY j.company_key
         ORDER BY company COLLATE NOCASE${limit}`,
  )
    .bind(userId, ...binds, ...(q ? [q] : []))
    .all()
  return c.json({ companies: rows.results })
})

jobs.post("/api/jobs/score", async (c) => {
  const body = await c.req.json<{ ids?: string[] }>().catch(() => ({}) as { ids?: string[] })
  const ids = Array.isArray(body.ids) ? body.ids.map(String) : []
  if (ids.length === 0) return c.json({ error: "ids required" }, 400)
  try {
    return c.json({ jobs: await scoreJobsByIds(c.env, ids, currentUser(c).id) })
  } catch (error) {
    const detail = message(error)
    if (error instanceof QuotaError) return c.json({ error: detail }, 429)
    return c.json({ error: detail }, detail === "not found" ? 404 : 502)
  }
})

jobs.get("/api/jobs/:id", async (c) => {
  const job = await loadJobDetail(c.env, currentUser(c).id, c.req.param("id"))
  if (!job) return c.json({ error: "not found" }, 404)
  return c.json({ job })
})

jobs.patch("/api/jobs/:id", async (c) => {
  const id = c.req.param("id")
  const userId = currentUser(c).id
  const body = await c.req.json<{
    status?: string
    notes?: string
    viewed?: boolean
    later?: boolean
    cv_url?: string | null
    claude_comment?: string | null
  }>()
  if (body.status && !STATUSES.includes(body.status)) return c.json({ error: "bad status" }, 400)
  const cvUrl = body.cv_url === undefined ? undefined : cleanCvUrl(body.cv_url)
  if (cvUrl === false) return c.json({ error: "cv_url must be an http(s) link" }, 400)
  if (body.claude_comment !== undefined && body.claude_comment !== null && typeof body.claude_comment !== "string") {
    return c.json({ error: "claude_comment must be text" }, 400)
  }
  if (
    body.status === undefined &&
    body.notes === undefined &&
    typeof body.viewed !== "boolean" &&
    typeof body.later !== "boolean" &&
    cvUrl === undefined &&
    body.claude_comment === undefined
  ) {
    return c.json({ error: "nothing to update" }, 400)
  }

  const root = await c.env.DB.prepare(`SELECT COALESCE(duplicate_of, id) AS id FROM jobs WHERE id = ?`)
    .bind(id)
    .first<{ id: string }>()
  if (!root) return c.json({ error: "not found" }, 404)
  const jobId = root.id

  await c.env.DB.prepare(`INSERT OR IGNORE INTO user_jobs (user_id, job_id) VALUES (?, ?)`).bind(userId, jobId).run()

  const sets: string[] = []
  const binds: (string | null)[] = []
  if (body.status) {
    sets.push("status = ?")
    binds.push(body.status)
    if (body.status === "applied" || body.status === "interview") {
      sets.push("applied_at = COALESCE(applied_at, datetime('now'))")
    } else if (body.status !== "rejected") {
      sets.push("applied_at = NULL")
    }
    if (body.status === "interview") {
      sets.push("interviewed_at = COALESCE(interviewed_at, datetime('now'))")
    }
  }
  if (body.notes !== undefined) {
    sets.push("notes = ?")
    binds.push(body.notes)
  }
  if (typeof body.viewed === "boolean") {
    sets.push(body.viewed ? "viewed_at = COALESCE(viewed_at, datetime('now'))" : "viewed_at = NULL")
  }
  if (typeof body.later === "boolean") {
    sets.push(body.later ? "later_at = COALESCE(later_at, datetime('now'))" : "later_at = NULL")
  }
  if (cvUrl !== undefined) {
    sets.push("cv_url = ?")
    binds.push(cvUrl)
  }
  if (body.claude_comment !== undefined) {
    sets.push("claude_comment = ?")
    binds.push(body.claude_comment?.trim() || null)
  }

  await c.env.DB.prepare(`UPDATE user_jobs SET ${sets.join(", ")} WHERE user_id = ? AND job_id = ?`)
    .bind(...binds, userId, jobId)
    .run()

  const row = await c.env.DB.prepare(
    `SELECT status, notes, applied_at, viewed_at, later_at, interviewed_at, cv_url, claude_comment
     FROM user_jobs WHERE user_id = ? AND job_id = ?`,
  )
    .bind(userId, jobId)
    .first<{
      status: string
      notes: string | null
      applied_at: string | null
      viewed_at: string | null
      later_at: string | null
      interviewed_at: string | null
      cv_url: string | null
      claude_comment: string | null
    }>()
  return c.json({
    ok: true,
    status: row?.status ?? body.status ?? "",
    notes: row?.notes ?? null,
    applied_at: row?.applied_at ?? null,
    viewed_at: row?.viewed_at ?? null,
    later_at: row?.later_at ?? null,
    interviewed_at: row?.interviewed_at ?? null,
    cv_url: row?.cv_url ?? null,
    claude_comment: row?.claude_comment ?? null,
  })
})

jobs.post("/api/jobs/:id/stages", async (c) => {
  const id = c.req.param("id")
  const userId = currentUser(c).id
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>)
  const stage = readStage(body, false)
  if (typeof stage === "string") return c.json({ error: stage }, 400)
  const exists = await c.env.DB.prepare(`SELECT id FROM jobs WHERE id = ?`).bind(id).first<{ id: string }>()
  if (!exists) return c.json({ error: "not found" }, 404)
  await c.env.DB.prepare(`INSERT INTO interview_stages (user_id, job_id, title, happened_on) VALUES (?, ?, ?, ?)`)
    .bind(userId, id, stage.title, stage.happened_on ?? null)
    .run()
  return c.json({ stages: await loadStages(c.env, userId, id) }, 201)
})

jobs.patch("/api/jobs/:id/stages/:stageId", async (c) => {
  const id = c.req.param("id")
  const userId = currentUser(c).id
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>)
  const stage = readStage(body, true)
  if (typeof stage === "string") return c.json({ error: stage }, 400)
  const sets: string[] = []
  const binds: (string | null)[] = []
  if (stage.title !== undefined) {
    sets.push("title = ?")
    binds.push(stage.title)
  }
  if (stage.happened_on !== undefined) {
    sets.push("happened_on = ?")
    binds.push(stage.happened_on)
  }
  const result = await c.env.DB.prepare(
    `UPDATE interview_stages SET ${sets.join(", ")} WHERE id = ? AND user_id = ? AND job_id = ?`,
  )
    .bind(...binds, Number(c.req.param("stageId")), userId, id)
    .run()
  if (!result.meta.changes) return c.json({ error: "not found" }, 404)
  return c.json({ stages: await loadStages(c.env, userId, id) })
})

jobs.delete("/api/jobs/:id/stages/:stageId", async (c) => {
  const id = c.req.param("id")
  const userId = currentUser(c).id
  const result = await c.env.DB.prepare(`DELETE FROM interview_stages WHERE id = ? AND user_id = ? AND job_id = ?`)
    .bind(Number(c.req.param("stageId")), userId, id)
    .run()
  if (!result.meta.changes) return c.json({ error: "not found" }, 404)
  return c.json({ stages: await loadStages(c.env, userId, id) })
})

jobs.post("/api/jobs/:id/score", async (c) => {
  try {
    return c.json(await scoreOneJob(c.env, c.req.param("id"), currentUser(c).id))
  } catch (error) {
    const detail = message(error)
    if (error instanceof QuotaError) return c.json({ error: detail }, 429)
    return c.json({ error: detail }, detail === "not found" ? 404 : 502)
  }
})

jobs.post("/api/jobs/:id/primary", async (c) => {
  const id = c.req.param("id")
  const exists = await c.env.DB.prepare(`SELECT id FROM jobs WHERE id = ?`).bind(id).first<{ id: string }>()
  if (!exists) return c.json({ error: "not found" }, 404)
  const ok = await setPrimaryListing(c.env, id)
  if (!ok) return c.json({ error: "no duplicates" }, 400)
  const job = await loadJobDetail(c.env, currentUser(c).id, id)
  if (!job) return c.json({ error: "not found" }, 404)
  return c.json({ job })
})
