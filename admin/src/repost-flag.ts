export type RepostFlag = {
  repost_of: string
  prev_status: "applied" | "interview" | "rejected"
  prev_date: string
  match: "exact" | "similar"
}

export function readRepost(raw: string | null | undefined): RepostFlag | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    if (typeof record.repost_of !== "string") return null
    if (record.prev_status !== "applied" && record.prev_status !== "interview" && record.prev_status !== "rejected") return null
    if (record.match !== "exact" && record.match !== "similar") return null
    if (typeof record.prev_date !== "string") return null
    return {
      repost_of: record.repost_of,
      prev_status: record.prev_status,
      prev_date: record.prev_date,
      match: record.match,
    }
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

export function repostDate(value: string): string {
  const day = value.slice(0, 10)
  const [year, month, date] = day.split("-")
  if (!year || !month || !date) return day
  return `${date}.${month}.${year}`
}
