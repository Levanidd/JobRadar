import { isAtsProvider } from "./boards"
import { isPlaceOnly, locationKey } from "./places"

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

/** Tails that are a site or a holding, not the employer. Only the end of the key. */
const MATCH_TAIL = / (com|io|ai|group|solutions|technologies|labs|hq|holding|inc|ltd|llc|bv|oy|ab|as|sa|spa|srl)$/

/**
 * A looser company key for twin search and repost lookup. `company_key` stays
 * as it is: Impact and impact.com share this key, and a different career
 * domain is what keeps them apart.
 */
export function companyMatchKey(name: string): string {
  let key = companyKey(name)
  for (let step = 0; step < 3; step++) {
    const next = key.replace(MATCH_TAIL, "")
    if (next === key) break
    key = next
  }
  return key
}

const ATS_BOARD = /(?:^|\.)(?:greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|smartrecruiters\.com|recruitee\.com|personio\.(?:de|com)|workable\.com|teamtailor\.com|bamboohr\.com|breezy\.hr|pinpointhq\.com|rippling\.com|oraclecloud\.com|successfactors\.(?:com|eu)|gem\.com|join\.com)$/

/** Host, or the board slug when the host is shared by every customer of an ATS. */
export function careerDomain(url: string | null | undefined): string | null {
  if (!url) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const host = parsed.hostname.replace(/^www\./, "").toLowerCase()
  if (!host || host === "localhost") return null
  if (ATS_BOARD.test(host)) {
    const slug = parsed.pathname.split("/").filter(Boolean)[0]?.toLowerCase()
    if (!slug || slug === "jobs" || slug === "job") return null
    const board = host.includes("greenhouse")
      ? "greenhouse"
      : host.includes("lever")
        ? "lever"
        : host.includes("ashby")
          ? "ashby"
          : host
    return `${board}/${slug}`
  }
  const parts = host.split(".")
  if (parts.length >= 3 && (parts.at(-2) === "co" || parts.at(-2) === "com")) return parts.slice(-3).join(".")
  return parts.length >= 2 ? parts.slice(-2).join(".") : host
}

/** True when both postings name a career domain and the domains differ. */
export function domainsConflict(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b && a !== b)
}

/**
 * The employer's own board. An aggregator's posting URL is not one, so two
 * copies of Hospitable can still meet when only one of them links to Workable.
 */
export function employerDomain(
  provider: string,
  careersUrl: string | null | undefined,
  jobUrl: string | null | undefined,
): string | null {
  if (isAtsProvider(provider)) return careerDomain(careersUrl) ?? careerDomain(jobUrl)
  const career = careerDomain(careersUrl)
  const posting = careerDomain(jobUrl)
  if (career && career !== posting) return career
  return null
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
    .replace(/\b(all genders|any gender)\b/g, " ")
    .replace(/\(([^)]*)\)/g, (_, inner: string) => (isPlaceOnly(inner) ? " " : ` ${inner} `))
    .replace(PLACE_TAIL, " ")
    .replace(/\bsr\.?\b/g, "senior")
    .replace(/\bjr\.?\b/g, "junior")
    .replace(/\b(remote|hybrid|on[- ]site|onsite|wfh)\b/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** Company and role, without the place. Used to find candidate twins. */
export function roleKey(company: string, title: string): string {
  const who = companyKey(company)
  const role = titleKey(title)
  return who && role ? `${who}|${role}` : ""
}

export { locationKey, parsePlaces, placeCount, placesMatch, type PlaceSet } from "./places"

/**
 * Identifies one opening across the boards that carry it. The same role in
 * another city is a different opening. A missing location only matches
 * another missing location.
 */
export function dedupKey(company: string, title: string, location?: string | null): string {
  const role = roleKey(company, title)
  if (!role) return ""
  const place = locationKey(location)
  return place ? `${role}|${place}` : role
}

export async function jobHash(provider: string, token: string, externalId: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${provider}:${token}:${externalId}`)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}
