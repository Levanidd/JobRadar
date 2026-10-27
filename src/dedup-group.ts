import { boardRank } from "./boards"
import { placeCount } from "./places"

/** interview beats applied, which beats a rejection. A bare comment does not rank. */
const STATUS_RANK: Record<string, number> = {
  interview: 60,
  applied: 50,
  rejected: 40,
  saved: 35,
  ignored: 5,
  notified: 0,
  off_profile: 0,
  new: 0,
}

export type Verdict = {
  user_id: number
  job_id: string
  status: string
  score: number | null
  score_reason: string | null
  flags: string | null
  notes: string | null
  applied_at: string | null
  viewed_at: string | null
  later_at: string | null
  notified_at: string | null
  interviewed_at: string | null
  cv_url: string | null
  claude_comment: string | null
}

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000

export function actionRank(row: {
  status?: string | null
  later_at?: string | null
  viewed_at?: string | null
}): number {
  const status = row.status ?? "new"
  let rank = STATUS_RANK[status] ?? 0
  if (row.later_at && rank < 30) rank = 30
  if (row.viewed_at && rank < 20) rank = 20
  return rank
}

export function jobActionRank(jobId: string, rows: Verdict[]): number {
  let best = 0
  for (const row of rows) {
    if (row.job_id !== jobId) continue
    const rank = actionRank(row)
    if (rank > best) best = rank
  }
  return best
}

/**
 * Two applications by the same person, more than two days apart, are left as
 * two postings. A comment or a CV link is not an application.
 */
export function appliedConflict(rows: Pick<Verdict, "user_id" | "applied_at">[]): {
  userId: number
  dates: string[]
} | null {
  const byUser = new Map<number, string[]>()
  for (const row of rows) {
    if (!row.applied_at) continue
    const list = byUser.get(row.user_id) ?? []
    list.push(row.applied_at)
    byUser.set(row.user_id, list)
  }
  for (const [userId, dates] of byUser) {
    if (dates.length < 2) continue
    const times = dates.map((date) => Date.parse(date.replace(" ", "T") + "Z"))
    const span = Math.max(...times) - Math.min(...times)
    if (span > TWO_DAYS_MS) return { userId, dates: [...dates].sort() }
  }
  return null
}

function earliest(dates: Array<string | null>): string | null {
  const present = dates.filter((date): date is string => Boolean(date))
  if (present.length === 0) return null
  return present.sort()[0]!
}

function joinUnique(parts: Array<string | null>, separator: string): string | null {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of parts) {
    const text = part?.trim() ?? ""
    if (!text || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out.length > 0 ? out.join(separator) : null
}

/** Fields that land on the primary. The copies keep their own rows. */
export function mergeVerdicts(primaryJobId: string, rows: Verdict[]): Verdict[] {
  const byUser = new Map<number, Verdict[]>()
  for (const row of rows) {
    const list = byUser.get(row.user_id) ?? []
    list.push(row)
    byUser.set(row.user_id, list)
  }
  const merged: Verdict[] = []
  for (const [userId, group] of byUser) {
    const primary = group.find((row) => row.job_id === primaryJobId) ?? null
    const best = group.reduce((winner, row) => (actionRank(row) > actionRank(winner) ? row : winner))
    const scored = [...group].sort((a, b) => (b.score ?? -1) - (a.score ?? -1))[0]!
    merged.push({
      user_id: userId,
      job_id: primaryJobId,
      status: best.status ?? "new",
      applied_at: earliest(group.map((row) => row.applied_at)),
      interviewed_at: earliest(group.map((row) => row.interviewed_at)),
      viewed_at: earliest(group.map((row) => row.viewed_at)),
      later_at: earliest(group.map((row) => row.later_at)),
      notified_at: earliest(group.map((row) => row.notified_at)),
      notes: joinUnique(group.map((row) => row.notes), "\n"),
      claude_comment: joinUnique(group.map((row) => row.claude_comment), "\n\n"),
      cv_url: primary?.cv_url || group.find((row) => row.cv_url)?.cv_url || null,
      score: primary?.score != null ? primary.score : scored.score,
      score_reason: primary?.score != null ? primary.score_reason : scored.score_reason,
      flags: primary?.score != null ? primary.flags : scored.flags,
    })
  }
  return merged
}

export type Listing = {
  id: string
  location: string | null
  first_seen_at: string
  provider: string
}

/** The furthest application wins, then the fuller place, then the career site, then the earliest row. */
export function choosePrimary<T extends Listing>(jobs: T[], rows: Verdict[]): T {
  return [...jobs].sort((a, b) => {
    const rank = jobActionRank(b.id, rows) - jobActionRank(a.id, rows)
    if (rank !== 0) return rank
    const places = placeCount(b.location) - placeCount(a.location)
    if (places !== 0) return places
    const board = boardRank(b.provider) - boardRank(a.provider)
    if (board !== 0) return board
    return a.first_seen_at < b.first_seen_at ? -1 : a.first_seen_at > b.first_seen_at ? 1 : 0
  })[0]!
}

/**
 * A blank place joins the group only when every located primary names the same
 * place. Berlin and London stay apart, and a blank copy joins neither.
 */
export function blankPlaceKey(locationKeys: string[]): string | null {
  const known = [...new Set(locationKeys.filter((key) => key.length > 0))]
  return known.length === 1 ? known[0]! : null
}
