import { companyMatchKey } from "../company-key"
import { repostReason, shouldParkRepost, titleMatch, writeFlags } from "../repost"
import { runBatch } from "../db"
import type { Bindings } from "../types"

type PreviousApplication = {
  id: string
  title: string
  location: string | null
  status: string
  applied_at: string | null
  interviewed_at: string | null
}

type LegacyApplication = {
  company: string
  title: string
  status: string
  applied_at: string | null
  url: string | null
}

let legacyHistory: LegacyApplication[] | null = null
let legacyOff = false
let masterUserId: number | null | undefined
const legacyJobByUrl = new Map<string, string | null>()

/** The imported Agilefluent list has no user column. It belongs to the master account. */
async function previousApplications(env: Bindings, userId: number, matchKey: string): Promise<PreviousApplication[]> {
  const rows = await env.DB.prepare(
    `SELECT j.id, j.title, j.location, uj.status, uj.applied_at, uj.interviewed_at
     FROM jobs j
     JOIN user_jobs uj ON uj.job_id = j.id AND uj.user_id = ?
     WHERE j.company_match_key = ?
       AND (uj.applied_at IS NOT NULL OR uj.status IN ('applied', 'interview', 'rejected'))
     ORDER BY uj.applied_at DESC
     LIMIT 80`,
  )
    .bind(userId, matchKey)
    .all<PreviousApplication>()
  const found = rows.results
  if (masterUserId === undefined) {
    const master = await env.DB.prepare(`SELECT id FROM users WHERE role = 'master' ORDER BY id LIMIT 1`).first<{ id: number }>()
    masterUserId = master?.id ?? null
  }
  if (legacyOff || masterUserId !== userId) return found
  if (!legacyHistory) {
    try {
      const loaded = await env.DB.prepare(
        `SELECT company, title, status, applied_at, url
         FROM applied_history
         WHERE system = 'agilefluent'
           AND (applied_at IS NOT NULL OR status IN ('applied', 'interview', 'rejected'))
         LIMIT 500`,
      ).all<LegacyApplication>()
      legacyHistory = loaded.results
    } catch (error) {
      console.warn("applied_history unreadable, imported applications skipped for this isolate", error)
      legacyOff = true
      legacyHistory = []
      return found
    }
  }
  for (const row of legacyHistory) {
    if (!row.url || companyMatchKey(row.company) !== matchKey) continue
    let id = legacyJobByUrl.get(row.url)
    if (id === undefined) {
      const job = await env.DB.prepare(
        `SELECT id FROM jobs WHERE url = ? ORDER BY closed_at IS NOT NULL, duplicate_of IS NOT NULL LIMIT 1`,
      )
        .bind(row.url)
        .first<{ id: string }>()
      id = job?.id ?? null
      legacyJobByUrl.set(row.url, id)
    }
    if (!id) continue
    found.push({ id, title: row.title, location: null, status: row.status, applied_at: row.applied_at, interviewed_at: null })
  }
  return found
}

/** Marks a new primary when this person already applied to the same role here. Not a duplicate. */
export async function markReposts(
  env: Bindings,
  jobs: Array<{ id: string; company: string; title: string; url: string; location: string | null }>,
  _careersUrl: string | null,
): Promise<void> {
  const fresh = jobs.filter((job) => companyMatchKey(job.company).length >= 3)
  if (fresh.length === 0) return
  const users = await env.DB.prepare(`SELECT id FROM users`).all<{ id: number }>()
  const writes: D1PreparedStatement[] = []
  for (const user of users.results) {
    const cache = new Map<string, PreviousApplication[]>()
    for (const job of fresh) {
      const matchKey = companyMatchKey(job.company)
      let previous = cache.get(matchKey)
      if (!previous) {
        previous = await previousApplications(env, user.id, matchKey)
        cache.set(matchKey, previous)
      }
      const hit = previous
        .map((item) => ({ item, kind: item.id === job.id ? null : titleMatch(job.title, item.title) }))
        .filter((item): item is { item: PreviousApplication; kind: "exact" | "similar" } => item.kind !== null)
        .sort((a, b) => {
          if (a.kind !== b.kind) return a.kind === "exact" ? -1 : 1
          return (b.item.applied_at ?? "") > (a.item.applied_at ?? "") ? 1 : -1
        })[0]
      if (!hit) continue
      const status = hit.item.status === "interview" || hit.item.status === "rejected" ? hit.item.status : "applied"
      const date = hit.item.applied_at ?? hit.item.interviewed_at ?? ""
      if (!date) continue
      const flags = writeFlags(null, { repost_of: hit.item.id, prev_status: status, prev_date: date, match: hit.kind })
      const block = shouldParkRepost(flags, job.location, hit.item.location)
      writes.push(
        env.DB.prepare(
          `INSERT INTO user_jobs (user_id, job_id, status, score_reason, flags)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(user_id, job_id) DO UPDATE SET
             flags = excluded.flags,
             status = CASE
               WHEN user_jobs.applied_at IS NOT NULL OR user_jobs.status IN ('applied', 'interview', 'rejected', 'saved')
                 THEN user_jobs.status
               WHEN ? = 1 THEN 'off_profile'
               ELSE user_jobs.status
             END,
             score_reason = CASE
               WHEN ? = 1 AND user_jobs.applied_at IS NULL
                 AND user_jobs.status NOT IN ('applied', 'interview', 'rejected', 'saved')
                 THEN excluded.score_reason
               ELSE user_jobs.score_reason
             END`,
        ).bind(
          user.id,
          job.id,
          block ? "off_profile" : "new",
          block ? repostReason(status, date) : null,
          flags,
          block ? 1 : 0,
          block ? 1 : 0,
        ),
      )
    }
  }
  await runBatch(env, writes)
}
