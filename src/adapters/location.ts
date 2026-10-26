const WORKPLACE: Record<string, string> = {
  remote: "Remote",
  hybrid: "Hybrid",
  onsite: "OnSite",
}

/** Remote / Hybrid / OnSite, in the spelling the scorer should see. */
export function workplaceLabel(raw: string | null | undefined): string | undefined {
  if (!raw?.trim()) return undefined
  const key = raw.trim().toLowerCase().replace(/[\s_-]+/g, "")
  return WORKPLACE[key]
}

/**
 * One location string for a posting that is listed in several cities.
 * Order is kept, blanks and repeats are dropped, workplace sits in parentheses.
 * With no city and a remote flag, the string is just "Remote".
 */
export function formatLocation(
  places: Array<string | null | undefined>,
  options?: { workplace?: string | null; remote?: boolean },
): string | undefined {
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const raw of places) {
    const place = raw?.replace(/\s+/g, " ").trim()
    if (!place) continue
    const key = place.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    ordered.push(place)
  }
  const kind = workplaceLabel(options?.workplace)
  if (ordered.length === 0) {
    if (options?.remote || kind === "Remote") return "Remote"
    return undefined
  }
  if (kind === "Remote" && ordered.length === 1 && ordered[0].toLowerCase() === "remote") return "Remote"
  if (!kind) return ordered.join("; ")
  return `${ordered.join("; ")} (${kind})`
}
