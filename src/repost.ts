import { locationKey, titleKey } from "./company-key"

const SENIORITY = new Set(["senior", "staff", "lead", "principal", "junior"])
const DAY = 24 * 60 * 60 * 1000

export type RepostMatch = "exact" | "similar"

export type RepostFlag = {
  repost_of: string
  prev_status: "applied" | "interview" | "rejected"
  prev_date: string
  match: RepostMatch
}

export function titleTokens(title: string): Set<string> {
  return new Set(
    titleKey(title)
      .split(" ")
      .filter((word) => word && !SENIORITY.has(word)),
  )
}

export function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 1
  let shared = 0
  for (const word of left) if (right.has(word)) shared += 1
  const union = left.size + right.size - shared
  return union === 0 ? 0 : shared / union
}

/**
 * Exact titleKey, or the same role words with seniority ignored.
 * Two leftover words ("Lead Product Manager" and "Product Manager") are not
 * enough to call the titles similar.
 */
export function titleMatch(a: string, b: string): RepostMatch | null {
  if (titleKey(a) && titleKey(a) === titleKey(b)) return "exact"
  const left = titleTokens(a)
  const right = titleTokens(b)
  if (left.size < 3 || right.size < 3) return null
  if (jaccard(left, right) >= 0.8) return "similar"
  return null
}

export function readRepost(raw: string | null | undefined): RepostFlag | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    if (typeof record.repost_of !== "string" || !record.repost_of) return null
    const status = record.prev_status
    const match = record.match
    if (status !== "applied" && status !== "interview" && status !== "rejected") return null
    if (match !== "exact" && match !== "similar") return null
    if (typeof record.prev_date !== "string" || !record.prev_date) return null
    return { repost_of: record.repost_of, prev_status: status, prev_date: record.prev_date, match }
  } catch {
    return null
  }
}

export function flagTags(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.filter((flag): flag is string => typeof flag === "string")
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as { tags?: unknown }).tags)) {
      return (parsed as { tags: unknown[] }).tags.filter((flag): flag is string => typeof flag === "string")
    }
  } catch {
    return []
  }
  return []
}

export function writeFlags(raw: string | null | undefined, repost: RepostFlag, tags?: string[]): string {
  return JSON.stringify({ ...repost, tags: tags ?? flagTags(raw) })
}

export function recentExactRepost(raw: string | null | undefined, now = Date.now()): boolean {
  const repost = readRepost(raw)
  if (!repost || repost.match !== "exact") return false
  const then = Date.parse(repost.prev_date.includes("T") ? repost.prev_date : repost.prev_date.replace(" ", "T") + "Z")
  return Number.isFinite(then) && now - then < 60 * DAY && now - then >= 0
}

export function berlinDay(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now)
}

/**
 * An application made today, in another place, tagged relocation-only.
 * The flag is enough: Navan London and New York stay in the list.
 */
export function repostStaysVisible(
  repost: RepostFlag,
  tags: string[],
  location: string | null | undefined,
  previousLocation?: string | null,
  now = new Date(),
): boolean {
  if (repost.match !== "exact" || repost.prev_status !== "applied") return false
  if (!tags.includes("relocation_only")) return false
  if (repost.prev_date.slice(0, 10) !== berlinDay(now)) return false
  const here = locationKey(location)
  if (previousLocation === undefined) return here !== ""
  return here !== locationKey(previousLocation)
}

export function shouldParkRepost(
  raw: string | null | undefined,
  location: string | null | undefined,
  previousLocation?: string | null,
  now = new Date(),
): boolean {
  if (!recentExactRepost(raw, now.getTime())) return false
  const repost = readRepost(raw)
  if (!repost) return false
  return !repostStaysVisible(repost, flagTags(raw), location, previousLocation, now)
}

export function repostReason(status: string, date: string): string {
  return `репост: ${status} ${date.slice(0, 10)}`
}

/** Drops the repost object and leaves the scoring tags. */
export function clearRepost(raw: string | null | undefined): string {
  return JSON.stringify(flagTags(raw))
}
