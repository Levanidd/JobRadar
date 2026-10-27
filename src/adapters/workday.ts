import { asRecord, fetchJson, str } from "../http"
import { clipDescription } from "../prefilter"
import { BROWSER_LIKE_USER_AGENT } from "../vendor/career-ops/_http.mjs"
import workdayProvider from "../vendor/career-ops/workday.mjs"
import { fromCareerOps, labelFromUrl } from "./career-ops"

/**
 * The listing call only carries title and location. The posting body is a
 * second request: `GET /wday/cxs/{tenant}/{site}/job/...`.
 */
const WORKDAY_JOB =
  /^https:\/\/([\w-]+)\.(wd[\w-]*)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/?#]+)(\/job\/[^?#]*)/i

export function workdayDetailUrl(jobUrl: string): string | null {
  const match = jobUrl.match(WORKDAY_JOB)
  if (!match) return null
  const [, tenant, instance, site, path] = match
  return `https://${tenant}.${instance}.myworkdayjobs.com/wday/cxs/${tenant}/${site}${path}`
}

export const WORKDAY_PLACEHOLDER = /^\d+\s+locations?$/i

function pushPlace(value: unknown, into: string[]) {
  if (typeof value === "string" && value.trim()) into.push(value.trim())
  else if (Array.isArray(value)) value.forEach((item) => pushPlace(item, into))
  else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    pushPlace(record.location ?? record.descriptor ?? record.name ?? record.locationsText, into)
  }
}

/** Primary city plus the other offices, from a Workday posting detail. */
export function readWorkdayLocations(payload: unknown): string | undefined {
  const info = asRecord(asRecord(payload)?.jobPostingInfo)
  if (!info) return undefined
  const parts: string[] = []
  pushPlace(info.location, parts)
  pushPlace(info.additionalLocations, parts)
  pushPlace(info.locationsText, parts)
  const seen = new Set<string>()
  const ordered = parts.filter((place) => {
    const key = place.toLowerCase()
    if (seen.has(key) || WORKDAY_PLACEHOLDER.test(place)) return false
    seen.add(key)
    return true
  })
  return ordered.length > 0 ? ordered.join("; ") : undefined
}

export function readWorkdayDescription(payload: unknown): string | undefined {
  const info = asRecord(asRecord(payload)?.jobPostingInfo)
  return clipDescription(str(info?.jobDescription))
}

async function fetchWorkdayPayload(jobUrl: string): Promise<unknown | null> {
  const detail = workdayDetailUrl(jobUrl)
  if (!detail) return null
  const origin = new URL(detail).origin
  try {
    return await fetchJson(detail, {
      headers: {
        accept: "application/json",
        "accept-language": "en-US,en;q=0.9",
        "user-agent": BROWSER_LIKE_USER_AGENT,
        origin,
        referer: `${origin}/`,
      },
    })
  } catch {
    return null
  }
}

export async function fetchWorkdayDescription(jobUrl: string): Promise<string | null> {
  const payload = await fetchWorkdayPayload(jobUrl)
  return payload ? readWorkdayDescription(payload) ?? null : null
}

/** Real cities behind a "3 Locations" stub. Null when the detail page does not say. */
export async function fetchWorkdayLocations(jobUrl: string): Promise<string | null> {
  const payload = await fetchWorkdayPayload(jobUrl)
  return payload ? readWorkdayLocations(payload) ?? null : null
}

export const workday = fromCareerOps(workdayProvider, {
  kind: "company",
  entry: (token) => ({
    name: labelFromUrl(token),
    careers_url: token,
    api: token,
    provider: "workday",
    // One page is one subrequest, and a Worker gets few of those. Upstream
    // allows 100, which NVIDIA's 2000-posting tenant spends in full; ten pages
    // covers every employer that is not a giant.
    max_pages: 10,
  }),
})
