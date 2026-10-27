const SUFFIX = /\b(gmbh|se|ag|ltd|inc|b\.v\.|bv|llc|plc|kg|ohg|ug)\b/gi

export function companyKey(name: string): string {
  return name
    .toLowerCase()
    .replace(SUFFIX, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Arbeitnow often carries the legal name ("Acme Digital GmbH") while the
 * employer's own board is filed under a short slug ("Acme"). Those are the
 * same employer when one key is the other plus extra words.
 */
export function companiesRelated(a: string, b: string): boolean {
  if (!a || !b) return false
  if (a === b) return true
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  return long.startsWith(`${short} `) || long.endsWith(` ${short}`)
}

/** German and Dutch postings tag the title with a gender marker that varies by board. */
const GENDER_TAG = /\(\s*[mwfdxhv](\s*[/|]\s*[mwfdxhv])+\s*\)|\b[mwf]\s*\/\s*[wf]\s*\/\s*[dx]\b/gi

const PLACE_TAIL =
  /\s*[-–—,/]\s*(remote|hybrid|berlin|munich|m[uü]nchen|hamburg|k[oö]ln|cologne|frankfurt|d[uü]sseldorf|stuttgart|amsterdam|london|paris|zurich|z[uü]rich|vienna|wien|germany|deutschland|austria|[öo]sterreich|switzerland|schweiz|netherlands|emea|eu|dach|uk)\b.*$/i

/**
 * The words that name the role, without the decorations aggregators add and
 * employers leave off: gender tags, a city after a dash, Sr. vs Senior.
 */
export function titleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(GENDER_TAG, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(PLACE_TAIL, " ")
    .replace(/\bsr\.?\b/g, "senior")
    .replace(/\bjr\.?\b/g, "junior")
    .replace(/\b(remote|hybrid|on[- ]site|onsite|wfh)\b/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Spelling variants of one place. The value is the token that lands in the key.
 * Add a line here when a new alias shows up; do not special-case it in the parser.
 */
const PLACE_ALIASES: Record<string, string> = {
  "münchen": "munich",
  muenchen: "munich",
  munchen: "munich",
  "köln": "cologne",
  koeln: "cologne",
  koln: "cologne",
  deu: "germany",
  de: "germany",
  deutschland: "germany",
  "united kingdom": "uk",
  "great britain": "uk",
  gb: "uk",
  england: "uk",
  "new york city": "new york",
  nyc: "new york",
}

/** Workplace words. They describe how someone works, not where the role is. */
const PLACE_NOISE = new Set(["remote", "hybrid", "onsite", "office"])

/**
 * US state abbreviations. Dropped only when a city or country token is also
 * present, so "New York, NY" is New York and a bare "NY" is left alone.
 */
const STATE_CODES = new Set(
  "al ak az ar ca co ct dc fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh nj nm ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy".split(
    " ",
  ),
)

function placeToken(segment: string): string {
  const words = segment
    .replace(/-/g, " ")
    .replace(/\bon site\b/g, " ")
    .split(/\s+/)
    .filter((word) => word && !PLACE_NOISE.has(word))
  const phrase = words.join(" ")
  if (!phrase) return ""
  return PLACE_ALIASES[phrase] ?? phrase
}

/**
 * The places a posting names, so the same role in two cities stays two jobs.
 * An empty string means we do not know where it is: that copy may only match
 * another copy that is also missing a place.
 */
export function locationKey(location: string | null | undefined): string {
  if (!location?.trim()) return ""
  const text = location.toLowerCase().replace(/[()]/g, " ").replace(/\s+/g, " ").trim()
  const tokens = new Set<string>()
  for (const segment of text.split(/\s*(?:[;,/|]|\bor\b)\s*/)) {
    const token = placeToken(segment.trim())
    if (token) tokens.add(token)
  }
  const places = [...tokens].filter((token) => !STATE_CODES.has(token))
  const kept = places.length > 0 ? places : [...tokens]
  kept.sort()
  return kept.join("+")
}

/**
 * Identifies one opening across the boards that carry it. A role reaches us
 * from the employer's own board and from every aggregator that scraped it.
 * The same role in another city is a different opening. A missing location
 * only matches another missing location.
 */
export function dedupKey(company: string, title: string, location?: string | null): string {
  const role = titleKey(title)
  const who = companyKey(company)
  if (!who || !role) return ""
  const place = locationKey(location)
  return place ? `${who}|${role}|${place}` : `${who}|${role}`
}

export async function jobHash(provider: string, token: string, externalId: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${provider}:${token}:${externalId}`)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}
