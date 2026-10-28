import { companyKey, companyMatchKey, dedupKey, jobHash, roleKey } from "../company-key"
import { pick } from "../locale"
import { JOB_DESCRIPTION, JOB_TEXT_JOIN, saveJobText, textHash } from "../job-text"
import { clipDescription } from "../prefilter"
import { toSalary } from "../salary"
import type { Bindings } from "../types"

export type ManualJobInput = {
  title: string
  company: string
  url: string
  location?: string
  description?: string
  notes?: string
  salary_min?: unknown
  salary_max?: unknown
  salary_currency?: string
  status?: string
  applied_at?: string
}

function parseAppliedAt(raw: string | undefined): string | null {
  const value = raw?.trim() ?? ""
  if (!value) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value} 12:00:00`
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(value)) {
    return value.length === 16 ? `${value}:00` : value
  }
  return null
}

function parseJobUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim())
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    return url.href
  } catch {
    return null
  }
}

async function ensureManualSource(env: Bindings): Promise<number> {
  const existing = await env.DB.prepare(
    `SELECT id FROM sources WHERE provider = 'manual' AND token = 'manual'`,
  ).first<{ id: number }>()
  if (existing) return existing.id
  await env.DB.prepare(
    `INSERT INTO sources (kind, tier, label, provider, token, enabled)
     VALUES ('company', 'watchlist', 'Added by hand', 'manual', 'manual', 0)`,
  ).run()
  const created = await env.DB.prepare(
    `SELECT id FROM sources WHERE provider = 'manual' AND token = 'manual'`,
  ).first<{ id: number }>()
  if (!created) throw new Error("could not create manual source")
  return created.id
}

export async function createManualJob(env: Bindings, input: ManualJobInput, userId: number) {
  const title = input.title.trim()
  const company = input.company.trim()
  const url = parseJobUrl(input.url)
  if (!title || !company) throw new Error(pick("A title and a company are required", "Нужны должность и компания"))
  if (!url) throw new Error(pick("An http(s) link to the posting is required", "Нужна ссылка http(s) на позицию"))

  const status = input.status === "interview" ? "interview" : "applied"
  const sourceId = await ensureManualSource(env)
  const id = await jobHash("manual", "manual", url)
  const key = companyKey(company)
  const opening = dedupKey(company, title, input.location) || null
  const role = roleKey(company, title) || null
  const description = clipDescription(input.description) ?? null
  const hash = description ? await textHash(description) : null
  const notes = input.notes?.trim() || null
  const salary = toSalary({
    min: input.salary_min,
    max: input.salary_max,
    currency: input.salary_currency,
  })
  const appliedAt = parseAppliedAt(input.applied_at)

  await env.DB.prepare(
    `INSERT INTO jobs (
       id, source_id, external_id, company, company_key, company_match_key, title, location, url,
       posted_at, salary_min, salary_max, salary_currency, dedup_key, role_key, text_hash,
       first_seen_at, last_seen_at, changed_at, closed_at, status
     ) VALUES (
       ?, ?, ?, ?, ?, ?, ?, ?, ?,
       NULL, ?, ?, ?, ?, ?, ?,
       datetime('now'), datetime('now'), datetime('now'), NULL, 'new'
     )
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       company = excluded.company,
       company_key = excluded.company_key,
       company_match_key = excluded.company_match_key,
       location = excluded.location,
       salary_min = COALESCE(excluded.salary_min, jobs.salary_min),
       salary_max = COALESCE(excluded.salary_max, jobs.salary_max),
       salary_currency = COALESCE(excluded.salary_currency, jobs.salary_currency),
       dedup_key = excluded.dedup_key,
       role_key = excluded.role_key,
       text_hash = COALESCE(excluded.text_hash, jobs.text_hash),
       closed_at = NULL,
       last_seen_at = datetime('now'),
       changed_at = datetime('now')`,
  )
    .bind(
      id,
      sourceId,
      url,
      company,
      key,
      companyMatchKey(company),
      title,
      input.location?.trim() || null,
      url,
      salary?.min ?? null,
      salary?.max ?? null,
      salary?.currency || null,
      opening,
      role,
      hash,
    )
    .run()

  if (description) await saveJobText(env, id, description).run()

  await env.DB.prepare(
    `INSERT INTO user_jobs (user_id, job_id, status, notes, applied_at, interviewed_at)
     VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')), CASE WHEN ? = 'interview' THEN COALESCE(?, datetime('now')) END)
     ON CONFLICT(user_id, job_id) DO UPDATE SET
       status = excluded.status,
       notes = COALESCE(excluded.notes, user_jobs.notes),
       applied_at = COALESCE(user_jobs.applied_at, excluded.applied_at),
       interviewed_at = COALESCE(user_jobs.interviewed_at, excluded.interviewed_at)`,
  )
    .bind(userId, id, status, notes, appliedAt, status, appliedAt)
    .run()

  const job = await env.DB.prepare(
    `SELECT j.id, j.source_id, j.company, j.company_key, j.title, j.location, j.url,
            j.posted_at, j.first_seen_at, j.last_seen_at, j.changed_at,
            j.salary_min, j.salary_max, j.salary_currency,
            uj.score, uj.score_reason, uj.flags, COALESCE(uj.status, 'new') AS status,
            uj.applied_at, uj.viewed_at, uj.later_at, uj.interviewed_at, uj.notes, ${JOB_DESCRIPTION} AS description,
            s.tier, s.label as source_label
     FROM jobs j
     ${JOB_TEXT_JOIN}
     JOIN sources s ON s.id = j.source_id
     LEFT JOIN user_jobs uj ON uj.job_id = j.id AND uj.user_id = ?
     WHERE j.id = ?`,
  )
    .bind(userId, id)
    .first()
  if (!job) throw new Error("not found")
  return job
}
