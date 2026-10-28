import { Hono } from "hono"

import { adapters } from "../adapters"
import { currentUser, masterGuard } from "../auth"
import { detectUrl } from "../detect"
import { message } from "../errors"
import { prefilterAndScore, runSource } from "../ingest"
import type { AppEnv, SourceRow } from "../types"
import { readBody, stringField } from "./body"

export const sources = new Hono<AppEnv>()

sources.get("/api/sources", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT s.id, s.kind, s.tier, s.label, s.provider, s.token, s.careers_url, s.enabled,
       s.last_count, s.bootstrapped, s.deleted_at, s.created_at,
       COALESCE(s.last_run_at, j.last_seen_at) AS last_run_at,
       COALESCE(j.active_jobs, 0) AS active_jobs,
       r.error AS last_error,
       COALESCE(r.ok, CASE WHEN j.source_id IS NOT NULL THEN 1 END) AS last_ok
     FROM sources s
     LEFT JOIN (
       SELECT s2.id AS source_id,
         (
           SELECT COUNT(*) FROM jobs INDEXED BY idx_jobs_open_source
           WHERE source_id = s2.id AND closed_at IS NULL
         ) AS active_jobs,
         (
           SELECT MAX(last_seen_at) FROM jobs INDEXED BY idx_jobs_source_seen
           WHERE source_id = s2.id
         ) AS last_seen_at
       FROM sources s2
     ) j ON j.source_id = s.id
     LEFT JOIN (
       SELECT r.source_id, r.error, r.ok
       FROM source_runs r
       JOIN (SELECT source_id, MAX(id) AS id FROM source_runs GROUP BY source_id) latest
         ON latest.id = r.id
     ) r ON r.source_id = s.id
     WHERE s.deleted_at IS NULL AND s.provider != 'manual'
     ORDER BY s.created_at DESC, s.id DESC`,
  ).all()
  return c.json({ sources: rows.results })
})

sources.post("/api/sources", async (c) => {
  const raw = await readBody(c)
  const body = {
    kind: raw.kind === "company" || raw.kind === "query" ? raw.kind : undefined,
    tier: raw.tier === "watchlist" || raw.tier === "discovery" ? raw.tier : undefined,
    label: stringField(raw, "label"),
    provider: stringField(raw, "provider"),
    token: stringField(raw, "token"),
    careers_url: stringField(raw, "careers_url") || undefined,
  }
  if (!body.label || !body.provider || !body.token) {
    return c.json({ error: "label, provider, token required" }, 400)
  }
  await c.env.DB.prepare(
    `INSERT INTO sources (kind, tier, label, provider, token, careers_url)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider, token) DO UPDATE SET
       deleted_at = NULL, enabled = 1, label = excluded.label, tier = excluded.tier, careers_url = excluded.careers_url,
       created_at = datetime('now')`,
  )
    .bind(
      // The adapter knows whether its board is a company or a query, so a caller
      // cannot file a query board under the watchlist by mistake.
      adapters.find((item) => item.provider === body.provider)?.kind ?? body.kind ?? "company",
      body.tier ?? "watchlist",
      body.label,
      body.provider,
      body.token,
      body.careers_url ?? null,
    )
    .run()
  return c.json({ ok: true })
})

sources.patch("/api/sources/:id", async (c) => {
  const denied = masterGuard(c)
  if (denied) return denied
  const id = Number(c.req.param("id"))
  const raw = await readBody(c)
  const body = {
    enabled: raw.enabled === 0 || raw.enabled === 1 ? raw.enabled : undefined,
    tier: raw.tier === "watchlist" || raw.tier === "discovery" ? raw.tier : undefined,
    label: stringField(raw, "label") || undefined,
  }
  const current = await c.env.DB.prepare(`SELECT * FROM sources WHERE id = ?`).bind(id).first<SourceRow>()
  if (!current) return c.json({ error: "not found" }, 404)
  await c.env.DB.prepare(`UPDATE sources SET enabled = ?, tier = ?, label = ? WHERE id = ?`)
    .bind(body.enabled ?? current.enabled, body.tier ?? current.tier, body.label ?? current.label, id)
    .run()
  return c.json({ ok: true })
})

sources.delete("/api/sources/:id", async (c) => {
  const denied = masterGuard(c)
  if (denied) return denied
  await c.env.DB.prepare(`UPDATE sources SET deleted_at = datetime('now'), enabled = 0 WHERE id = ?`)
    .bind(Number(c.req.param("id")))
    .run()
  return c.json({ ok: true })
})

// `?score=0` leaves the queue alone: a full cycle scores once at the end
// instead of after every source, and the admin can report progress meanwhile.
sources.post("/api/sources/:id/run", async (c) => {
  const source = await c.env.DB.prepare(`SELECT * FROM sources WHERE id = ?`)
    .bind(Number(c.req.param("id")))
    .first<SourceRow>()
  if (!source) return c.json({ error: "not found" }, 404)
  const run = await runSource(c.env, source)
  if (c.req.query("score") === "0") return c.json({ run, scored: 0 })
  const userId = currentUser(c).id
  const { scored } = await prefilterAndScore(c.env, userId, undefined, { kind: "source", userId, trigger: "manual" })
  return c.json({ run, scored })
})

sources.post("/api/detect", async (c) => {
  const url = stringField(await readBody(c), "url")
  if (!url) return c.json({ error: "url required" }, 400)
  return c.json(await detectUrl(url, c.env))
})

sources.post("/api/sources/bulk-detect", async (c) => {
  const raw = (await readBody(c)).urls
  const urls = Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : []
  const results = []
  for (const url of urls) {
    try {
      results.push({ url, ...(await detectUrl(url, c.env)) })
    } catch (error) {
      results.push({
        url,
        ats: null,
        token: null,
        ok: false,
        jobs_found: 0,
        sample: [],
        guessed: false,
        error: message(error),
      })
    }
  }
  return c.json({ results })
})
