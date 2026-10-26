import type { Context } from "hono"

import { currentUser } from "../auth"
import { excludeBlockedCompaniesForUser } from "../settings"
import type { AppEnv } from "../types"

export type Ctx = Context<AppEnv>

/** Descriptions run to kilobytes each and no list ever shows them. */
export const JOB_COLUMNS = `j.id, j.source_id, j.company, j.company_key, j.title, j.location, j.url,
  j.posted_at, j.first_seen_at, j.last_seen_at, j.changed_at, j.salary_min, j.salary_max, j.salary_currency,
  j.duplicate_of,
  uj.score, uj.score_reason, uj.flags, COALESCE(uj.status, 'new') AS status,
  uj.applied_at, uj.viewed_at, uj.later_at, uj.interviewed_at`

/** A posting is only ever shown with the source that carries it and this user's verdict. */
export const JOB_SOURCE = `FROM jobs j
  JOIN sources s ON s.id = j.source_id
  LEFT JOIN user_jobs uj ON uj.job_id = j.id AND uj.user_id = ?`

export type Where = { clauses: string; binds: (string | number)[] }

const JOB_ORDER: Record<string, string> = {
  applied: `(uj.applied_at IS NOT NULL)`,
  viewed: `(uj.viewed_at IS NOT NULL)`,
  later: `(uj.later_at IS NOT NULL)`,
  title: "j.title COLLATE NOCASE",
  company: "j.company COLLATE NOCASE",
  score: "uj.score",
  posted: "COALESCE(j.posted_at, j.first_seen_at)",
  updated: "COALESCE(j.changed_at, j.first_seen_at)",
  added: "j.first_seen_at",
}

export function jobOrder(c: Ctx): string {
  const expr = JOB_ORDER[c.req.query("sort") ?? ""] ?? JOB_ORDER.score
  const dir = c.req.query("dir") === "asc" ? "ASC" : "DESC"
  return `${expr} ${dir} NULLS LAST, j.first_seen_at DESC, j.id`
}

export async function jobFilters(c: Ctx, withCompanies: boolean): Promise<Where> {
  const clauses = ["j.closed_at IS NULL", "j.duplicate_of IS NULL"]
  const binds: (string | number)[] = []
  const blocked = await excludeBlockedCompaniesForUser(c.env, currentUser(c).id, "j.company_key")
  clauses.push(blocked.sql)
  binds.push(...blocked.binds)

  // Nothing is dropped from the list for good: the default view hides what the
  // prefilter and the user set aside, `any` brings the whole pile back.
  const status = c.req.query("status")
  if (status && status !== "any") {
    clauses.push("COALESCE(uj.status, 'new') = ?")
    binds.push(status)
  } else if (!status) {
    clauses.push("COALESCE(uj.status, 'new') NOT IN ('ignored', 'off_profile')")
  }

  const minScore = Number(c.req.query("min_score") ?? 0)
  if (minScore) {
    clauses.push("uj.score >= ?")
    binds.push(minScore)
  }

  const tier = c.req.query("tier")
  if (tier) {
    clauses.push("s.tier = ?")
    binds.push(tier)
  }

  const companies = (c.req.query("companies") ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean)
  if (withCompanies && companies.length > 0) {
    clauses.push(`j.company_key IN (SELECT value FROM json_each(?))`)
    binds.push(JSON.stringify(companies))
  }

  const sourceId = Number(c.req.query("source_id") ?? 0)
  if (sourceId) {
    // "+" stops SQLite using idx_jobs_duplicate_of, so the plan starts from
    // the source's own rows instead of walking every primary in the table.
    const openPrimary = "j.duplicate_of IS NULL"
    const at = clauses.indexOf(openPrimary)
    if (at >= 0) clauses[at] = "+j.duplicate_of IS NULL"
    else clauses.push("+j.duplicate_of IS NULL")
    clauses.push(
      `j.id IN (
         SELECT id FROM jobs WHERE source_id = ? AND closed_at IS NULL
         UNION
         SELECT duplicate_of FROM jobs
         WHERE source_id = ? AND closed_at IS NULL AND duplicate_of IS NOT NULL
       )`,
    )
    binds.push(sourceId, sourceId)
  }

  const addedDays = Number(c.req.query("added_days") ?? 0)
  if (addedDays > 0) {
    clauses.push(`j.first_seen_at >= datetime('now', ?)`)
    binds.push(`-${addedDays} days`)
  }

  const addedFrom = (c.req.query("added_from") ?? "").trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(addedFrom)) {
    clauses.push(`j.first_seen_at >= ?`)
    binds.push(`${addedFrom} 00:00:00`)
  }

  const viewed = c.req.query("viewed")
  if (viewed === "yes") clauses.push("uj.viewed_at IS NOT NULL")
  if (viewed === "no") clauses.push("uj.viewed_at IS NULL")

  const later = c.req.query("later")
  if (later === "yes") clauses.push("uj.later_at IS NOT NULL")
  if (later === "no") clauses.push("uj.later_at IS NULL")

  // A rejection keeps applied_at, so the applied list still covers the ones that
  // came to nothing — which is the point of asking.
  const applied = c.req.query("applied")
  if (applied === "yes") clauses.push("uj.applied_at IS NOT NULL")
  if (applied === "no") clauses.push("uj.applied_at IS NULL")

  return { clauses: clauses.join(" AND "), binds }
}

/** A typed company name matches as a substring, and `%` / `_` stay literal. */
function likeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
}

/** The applied list is its own view: pipeline status instead of the list filters. */
export async function appliedFilters(c: Ctx): Promise<Where> {
  const clauses = ["uj.applied_at IS NOT NULL", "j.duplicate_of IS NULL"]
  const binds: (string | number)[] = []
  const blocked = await excludeBlockedCompaniesForUser(c.env, currentUser(c).id, "j.company_key")
  clauses.push(blocked.sql)
  binds.push(...blocked.binds)

  const company = (c.req.query("company") ?? "").trim().slice(0, 80)
  if (company) {
    clauses.push("j.company LIKE ? ESCAPE '\\'")
    binds.push(likeContains(company))
  }

  const status = c.req.query("status") ?? ""
  if (status === "applied") {
    clauses.push("uj.status = 'applied'")
  } else if (status === "interview") {
    // A rejection after an interview still belongs here: that was an interview.
    clauses.push("(uj.status = 'interview' OR uj.interviewed_at IS NOT NULL)")
  } else if (status === "rejected") {
    clauses.push("uj.status = 'rejected'")
  }

  const interviewed = c.req.query("interviewed")
  if (interviewed === "yes") clauses.push("uj.interviewed_at IS NOT NULL")
  if (interviewed === "no") clauses.push("uj.interviewed_at IS NULL")
  return { clauses: clauses.join(" AND "), binds }
}
