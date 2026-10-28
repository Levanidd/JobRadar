import { Hono } from "hono"

import { adapters } from "../adapters"
import { currentUser, masterGuard } from "../auth"
import { message } from "../errors"
import { ensureExploreSources, listExploreBoards } from "../explore"
import { addDiscovered, trackedCompanyKeys } from "../ingest"
import { blockedCompanyKeysForUser } from "../settings"
import { trackCompany } from "../sources"
import type { AppEnv } from "../types"

export const discovery = new Hono<AppEnv>()

discovery.get("/api/discovered", async (c) => {
  const state = c.req.query("state") ?? ""
  // One jobs scan instead of a count per company — the correlated version
  // burned D1's free daily row-read quota on a single Discovery load.
  let sql = `SELECT d.*, COALESCE(c.jobs_open, 0) AS jobs_open
     FROM discovered_companies d
     LEFT JOIN (
       SELECT company_key, COUNT(*) AS jobs_open
       FROM jobs
       WHERE closed_at IS NULL
       GROUP BY company_key
     ) c ON c.company_key = d.company_key`
  const binds: string[] = []
  if (state && state !== "all") {
    sql += " WHERE d.state = ?"
    binds.push(state)
  }
  sql += " ORDER BY d.best_score DESC NULLS LAST, jobs_open DESC"
  const stmt = c.env.DB.prepare(sql)
  const rows = binds.length ? await stmt.bind(...binds).all() : await stmt.all()
  return c.json({ companies: rows.results })
})

discovery.post("/api/discovered/:key/add", async (c) => {
  try {
    return c.json(await addDiscovered(c.env, c.req.param("key")))
  } catch (error) {
    // addDiscovered throws "not found" for an unknown key; anything else is a real failure.
    if (message(error) === "not found") return c.json({ error: "not found" }, 404)
    throw error
  }
})

discovery.post("/api/discovered/:key/dismiss", async (c) => {
  await c.env.DB.prepare(`UPDATE discovered_companies SET state = 'dismissed' WHERE company_key = ?`)
    .bind(c.req.param("key"))
    .run()
  return c.json({ ok: true })
})

// Explore re-fetches whole job boards on demand, past the 3-hour throttle
// the cycle keeps, so only a master gets to run it.
for (const path of ["/api/explore", "/api/explore/*"]) {
  discovery.use(path, async (c, next) => masterGuard(c) ?? (await next()))
}

discovery.get("/api/explore/boards", async (c) => c.json({ boards: await listExploreBoards(c.env.DB) }))

discovery.post("/api/explore/prepare", async (c) => {
  const body = await c.req.json<{ providers?: string[] }>().catch(() => ({}) as { providers?: string[] })
  return c.json(await ensureExploreSources(c.env, body.providers ?? []))
})

discovery.get("/api/explore", async (c) => {
  const providers = (c.req.query("providers") ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => adapters.some((adapter) => adapter.provider === item && adapter.kind === "query"))
  if (providers.length === 0) return c.json({ companies: [] })

  const rows = await c.env.DB.prepare(
    `WITH ranked AS (
       SELECT j.company_key, j.company, j.url, uj.score, s.provider,
         ROW_NUMBER() OVER (
           PARTITION BY j.company_key
           ORDER BY uj.score DESC NULLS LAST, j.first_seen_at DESC
         ) AS rn
       FROM jobs j
       JOIN sources s ON s.id = j.source_id
       LEFT JOIN user_jobs uj ON uj.job_id = j.id AND uj.user_id = ?
       WHERE j.closed_at IS NULL AND s.kind = 'query' AND s.deleted_at IS NULL
         AND s.provider IN (SELECT value FROM json_each(?))
         AND j.company_key IS NOT NULL AND j.company_key != ''
     )
     SELECT company_key,
       MIN(company) AS company,
       COUNT(*) AS jobs,
       MAX(score) AS best_score,
       MAX(CASE WHEN rn = 1 THEN url END) AS sample_url,
       GROUP_CONCAT(DISTINCT provider) AS providers
     FROM ranked
     GROUP BY company_key
     ORDER BY best_score DESC NULLS LAST, jobs DESC
     LIMIT 800`,
  )
    .bind(currentUser(c).id, JSON.stringify(providers))
    .all<{ company_key: string }>()

  // Explore is a suggestion list: an employer we already follow or already
  // blocked is not a suggestion.
  const [blocked, watched] = await Promise.all([
    blockedCompanyKeysForUser(c.env, currentUser(c).id),
    trackedCompanyKeys(c.env.DB),
  ])
  const companies = rows.results.filter(
    (row) => row.company_key && !watched.has(row.company_key) && !blocked.has(row.company_key),
  )
  return c.json({ companies })
})

discovery.post("/api/explore/:key/add", async (c) => {
  const key = c.req.param("key")
  const row = await c.env.DB.prepare(
    `SELECT j.company, j.url FROM jobs j
     LEFT JOIN user_jobs uj ON uj.job_id = j.id AND uj.user_id = ?
     WHERE j.company_key = ? AND j.closed_at IS NULL
     ORDER BY uj.score DESC NULLS LAST, j.first_seen_at DESC
     LIMIT 1`,
  )
    .bind(currentUser(c).id, key)
    .first<{ company: string; url: string }>()
  if (!row) return c.json({ error: "not found" }, 404)
  return c.json(await trackCompany(c.env, key, row.company, row.url))
})
