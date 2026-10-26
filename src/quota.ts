import { pick } from "./locale"
import type { Bindings } from "./types"

/** Postings a regular user may send to the model per calendar month (UTC). The master is not capped. */
export const MONTHLY_SCORE_LIMIT = 5000

export type ScoreQuota = {
  used: number
  /** null for the master. */
  limit: number | null
  /** null for the master. */
  remaining: number | null
  /** First moment of the next month, when `used` starts again from zero. */
  resets_at: string
}

export class QuotaError extends Error {}

export function monthStart(now: Date, offset = 0): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1)).toISOString()
}

/**
 * Counts postings the model actually judged for this person this month. Lab
 * runs and model checks are the master's tooling, not the person's scoring,
 * and a failed request returned no verdict, so neither counts.
 */
export async function scoresUsedThisMonth(env: Bindings, userId: number, now = new Date()): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(r.jobs), 0) AS n
     FROM model_requests r
     JOIN model_batches b ON b.id = r.batch_id
     WHERE b.user_id = ? AND b.kind NOT IN ('lab', 'check') AND r.ok = 1 AND r.started_at >= ?`,
  )
    .bind(userId, monthStart(now))
    .first<{ n: number }>()
  return Number(row?.n ?? 0)
}

export async function loadScoreQuota(env: Bindings, userId: number, now = new Date()): Promise<ScoreQuota> {
  const user = await env.DB.prepare(`SELECT role FROM users WHERE id = ?`).bind(userId).first<{ role: string }>()
  const used = await scoresUsedThisMonth(env, userId, now)
  const limit = user?.role === "master" ? null : MONTHLY_SCORE_LIMIT
  return {
    used,
    limit,
    remaining: limit === null ? null : Math.max(0, limit - used),
    resets_at: monthStart(now, 1),
  }
}

export function quotaMessage(quota: ScoreQuota): string {
  const date = quota.resets_at.slice(0, 10)
  return pick(
    `Monthly limit of ${quota.limit} model scores is used up. It resets on ${date}.`,
    `Месячный лимит в ${quota.limit} оценок моделью исчерпан. Обнулится ${date}.`,
  )
}
