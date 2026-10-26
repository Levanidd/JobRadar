import { Hono } from "hono"

import { currentUser } from "../auth"
import { excludeBlockedCompaniesForUser } from "../settings"
import type { AppEnv } from "../types"

export const stats = new Hono<AppEnv>()

export const WEEK_COUNT = 12
export const MONTH_COUNT = 12

export type Bucket = {
  start: string
  applied: number
  interview: number
  rejected: number
  total: number
}

type TotalsRow = {
  found: number | null
  open: number | null
  viewed: number | null
  later: number | null
  applied: number | null
}

type PipelineRow = {
  waiting: number | null
  interview: number | null
  rejected: number | null
}

type CompanyRow = { company_key: string; company: string; n: number }

function n(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function utcDay(from = new Date()): Date {
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()))
}

function mondayOf(day: Date): Date {
  const date = new Date(day.getTime())
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7))
  return date
}

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function emptyBucket(start: string): Bucket {
  return { start, applied: 0, interview: 0, rejected: 0, total: 0 }
}

function asBucket(row: { start: string; applied: unknown; interview: unknown; rejected: unknown; total: unknown }): Bucket {
  const applied = n(row.applied)
  const interview = n(row.interview)
  const rejected = n(row.rejected)
  return {
    start: row.start,
    applied,
    interview,
    rejected,
    total: n(row.total) || applied + interview + rejected,
  }
}

/** Last `WEEK_COUNT` Mondays, UTC, matching SQLite `date(..., weekday back to Monday)`. */
export function fillWeeks(rows: Bucket[]): Bucket[] {
  const byStart = new Map(rows.map((row) => [row.start, row]))
  const cursor = mondayOf(utcDay())
  cursor.setUTCDate(cursor.getUTCDate() - (WEEK_COUNT - 1) * 7)
  const out: Bucket[] = []
  for (let i = 0; i < WEEK_COUNT; i++) {
    const start = ymd(cursor)
    out.push(byStart.get(start) ?? emptyBucket(start))
    cursor.setUTCDate(cursor.getUTCDate() + 7)
  }
  return out
}

/** Last `MONTH_COUNT` calendar months, UTC, matching `strftime('%Y-%m', ...)`. */
export function fillMonths(rows: Bucket[]): Bucket[] {
  const byStart = new Map(rows.map((row) => [row.start, row]))
  const today = utcDay()
  let year = today.getUTCFullYear()
  let month = today.getUTCMonth()
  const keys: string[] = []
  for (let i = 0; i < MONTH_COUNT; i++) {
    keys.push(`${year}-${String(month + 1).padStart(2, "0")}`)
    month -= 1
    if (month < 0) {
      month = 11
      year -= 1
    }
  }
  return keys.reverse().map((start) => byStart.get(start) ?? emptyBucket(start))
}

/** An interview that later became a rejection still counts as the interview. */
const HAD_INTERVIEW = `(uj.status = 'interview' OR uj.interviewed_at IS NOT NULL)`

const PIPELINE_BREAKDOWN = `
  SUM(CASE WHEN ${HAD_INTERVIEW} THEN 1 ELSE 0 END) AS interview,
  SUM(CASE WHEN uj.status = 'rejected' AND uj.interviewed_at IS NULL THEN 1 ELSE 0 END) AS rejected,
  SUM(CASE WHEN NOT ${HAD_INTERVIEW} AND uj.status <> 'rejected' THEN 1 ELSE 0 END) AS applied`

/** `days` back from now, as the ISO string the timestamp columns are stored in. */
export function periodStart(raw: string | undefined, now = new Date()): string | null {
  const days = Number(raw)
  if (!Number.isFinite(days) || days <= 0) return null
  return new Date(now.getTime() - days * 86_400_000).toISOString()
}

stats.get("/api/stats", async (c) => {
  const userId = currentUser(c).id
  const blocked = await excludeBlockedCompaniesForUser(c.env, userId, "j.company_key")
  const where = `${blocked.sql} AND j.duplicate_of IS NULL`
  const binds = [userId, ...blocked.binds]
  const join = `FROM jobs j INDEXED BY idx_jobs_primary LEFT JOIN user_jobs uj ON uj.job_id = j.id AND uj.user_id = ?`
  // Applications are few. Start from that partial index and look each job up
  // by primary key, instead of walking every primary row in jobs.
  const applications = `FROM user_jobs uj CROSS JOIN jobs j ON j.id = uj.job_id`

  // A period narrows each number to the events that fall inside it, and every
  // number has its own event: a job counts as found when we first saw it, as
  // viewed when it was marked viewed or applied to, as an application when it
  // was sent. The two charts keep their own fixed windows — that is what they are for.
  const since = periodStart(c.req.query("days"))
  const found = since ? "j.first_seen_at >= ?" : "1"
  const acted = (column: string) => (since ? `uj.${column} >= ?` : `uj.${column} IS NOT NULL`)
  // Applying means the posting was looked at, so it counts as viewed even
  // without the viewed checkbox. A job that is both is still one.
  const saw = since
    ? `(uj.viewed_at >= ? OR uj.applied_at >= ?)`
    : `(uj.viewed_at IS NOT NULL OR uj.applied_at IS NOT NULL)`
  // These placeholders sit in the SELECT list, ahead of the one the join binds.
  const totalsBinds = since ? [since, since, since, since, since, since, ...binds] : binds
  const appliedBinds = since ? [userId, since, ...blocked.binds] : binds

  const [totals, pipeline, companies, weeks, months] = await c.env.DB.batch<
    TotalsRow | PipelineRow | CompanyRow | Bucket
  >([
    c.env.DB.prepare(
      `SELECT
         SUM(CASE WHEN ${found} THEN 1 ELSE 0 END) AS found,
         SUM(CASE WHEN ${found} AND j.closed_at IS NULL THEN 1 ELSE 0 END) AS open,
         SUM(CASE WHEN ${saw} THEN 1 ELSE 0 END) AS viewed,
         SUM(CASE WHEN ${acted("later_at")} THEN 1 ELSE 0 END) AS later,
         SUM(CASE WHEN ${acted("applied_at")} THEN 1 ELSE 0 END) AS applied
       ${join}
       WHERE ${where}`,
    ).bind(...totalsBinds),
    c.env.DB.prepare(
      `SELECT
         SUM(CASE WHEN ${HAD_INTERVIEW} THEN 1 ELSE 0 END) AS interview,
         SUM(CASE WHEN uj.status = 'rejected' AND uj.interviewed_at IS NULL THEN 1 ELSE 0 END) AS rejected,
         SUM(CASE WHEN NOT ${HAD_INTERVIEW} AND uj.status <> 'rejected' THEN 1 ELSE 0 END) AS waiting
       ${applications}
       WHERE uj.user_id = ? AND ${acted("applied_at")} AND ${where}`,
    ).bind(...appliedBinds),
    c.env.DB.prepare(
      `SELECT j.company_key, MIN(j.company) AS company, COUNT(*) AS n
       ${applications}
       WHERE uj.user_id = ? AND ${acted("applied_at")} AND ${where}
       GROUP BY j.company_key
       ORDER BY n DESC, company COLLATE NOCASE
       LIMIT 8`,
    ).bind(...appliedBinds),
    c.env.DB.prepare(
      `SELECT
         date(uj.applied_at, '-' || ((CAST(strftime('%w', uj.applied_at) AS INTEGER) + 6) % 7) || ' days') AS start,
         ${PIPELINE_BREAKDOWN},
         COUNT(*) AS total
       ${applications}
       WHERE uj.user_id = ? AND uj.applied_at IS NOT NULL AND ${where}
       GROUP BY start
       ORDER BY start`,
    ).bind(...binds),
    c.env.DB.prepare(
      `SELECT
         strftime('%Y-%m', uj.applied_at) AS start,
         ${PIPELINE_BREAKDOWN},
         COUNT(*) AS total
       ${applications}
       WHERE uj.user_id = ? AND uj.applied_at IS NOT NULL AND ${where}
       GROUP BY start
       ORDER BY start`,
    ).bind(...binds),
  ])

  const totalsRow = (totals.results[0] as TotalsRow | undefined) ?? {
    found: 0,
    open: 0,
    viewed: 0,
    later: 0,
    applied: 0,
  }
  const pipelineRow = (pipeline.results[0] as PipelineRow | undefined) ?? {
    waiting: 0,
    interview: 0,
    rejected: 0,
  }

  return c.json({
    found: n(totalsRow.found),
    open: n(totalsRow.open),
    viewed: n(totalsRow.viewed),
    later: n(totalsRow.later),
    applied: n(totalsRow.applied),
    pipeline: {
      waiting: n(pipelineRow.waiting),
      interview: n(pipelineRow.interview),
      rejected: n(pipelineRow.rejected),
    },
    companies: (companies.results as CompanyRow[]).map((row) => ({
      company_key: row.company_key,
      company: row.company,
      n: n(row.n),
    })),
    weeks: fillWeeks((weeks.results as Array<Bucket & { start: string }>).filter((row) => row.start).map(asBucket)),
    months: fillMonths((months.results as Array<Bucket & { start: string }>).filter((row) => row.start).map(asBucket)),
  })
})
