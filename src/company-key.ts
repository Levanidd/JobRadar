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
