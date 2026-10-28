/* Reading pasted career-page links. Same rules as the Sources pane of the current admin. */

const ATS_SUBDOMAINS = new Set(["jobs", "boards", "job-boards", "apply", "careers"])

const SLUG = /^[a-z0-9][a-z0-9._-]*$/i

function labelFromUrl(raw: string): string {
  try {
    const url = new URL(raw.startsWith("http") ? raw : `https://${raw}`)
    const parts = url.hostname.replace(/^www\./, "").split(".")
    const candidate = ATS_SUBDOMAINS.has(parts[0] ?? "") ? (parts[1] ?? parts[0]) : parts[0]
    const name = candidate ?? raw
    return name.charAt(0).toUpperCase() + name.slice(1)
  } catch {
    return raw
  }
}

function prettify(slug: string): string {
  return slug
    .split(/[-_.]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

/** One link per line, or several separated by commas. Bullets and numbering are dropped. */
export function parseBulkUrls(raw: string): { urls: string[]; leftover: string[] } {
  const urls: string[] = []
  const leftover: string[] = []
  const seen = new Set<string>()
  for (const line of raw.split(/\n+/)) {
    const pieces = line
      .split(/,\s+(?=https?:\/\/|\S+\.\S+)/i)
      .map((part) => part.replace(/^[•\-*\d.)\s]+/, "").trim())
      .filter(Boolean)
    for (const piece of pieces) {
      const href = /^https?:\/\//i.test(piece) ? piece : `https://${piece}`
      try {
        const url = new URL(href).href
        if (seen.has(url)) continue
        seen.add(url)
        urls.push(url)
      } catch {
        leftover.push(piece)
      }
    }
  }
  return { urls, leftover }
}

/**
 * On a shared board the host names the ATS and the path names the employer, so
 * a label taken from the domain reads "Ashbyhq" for every company on Ashby. The
 * detected token is that employer's own slug; only fall back to the domain when
 * the token is not one (Workday hands back a whole URL).
 */
export function labelFor(raw: string, token: string | null): string {
  return token && SLUG.test(token) ? prettify(token) : labelFromUrl(raw)
}

/** «himalayas.app» out of a posting link, for a compact cell. */
export function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname.replace(/^www\./, "")
  } catch {
    return raw
  }
}
