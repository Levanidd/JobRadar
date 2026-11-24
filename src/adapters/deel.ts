import { asArray, asRecord, fetchText, str, toIso } from "../http"
import { clipDescription } from "../prefilter"
import { toSalary } from "../salary"
import type { Adapter, RawJob } from "../types"
import { formatLocation } from "./location"

/**
 * Deel's own careers site. The public Ashby board for "deel" is empty; the
 * listings are embedded in https://www.deel.com/careers/ and the posting body
 * is only on the job page. That page is fetched later, for jobs that reach scoring.
 */
const ORIGIN = "https://www.deel.com"
const CAREERS = `${ORIGIN}/careers/`

export function deelJobUrl(id: string): string {
  return `${ORIGIN}/careers/job/${id}/`
}

export function deelDetailUrl(jobUrl: string): string | null {
  try {
    const url = new URL(jobUrl)
    if (url.hostname !== "www.deel.com" && url.hostname !== "deel.com") return null
    const id = /^\/careers\/job\/([0-9a-f-]{36})\/?$/i.exec(url.pathname)?.[1]
    return id ? deelJobUrl(id) : null
  } catch {
    return null
  }
}

function deelSalary(summary: string | undefined) {
  if (!summary) return undefined
  const match = /([\d][\d,]*)\s*-\s*\$?\s*([\d][\d,]*)\s*([A-Z]{3})/.exec(summary)
  if (!match) return undefined
  return toSalary({ min: match[1], max: match[2], currency: match[3] })
}

/** The careers page stores the list as an escaped JSON array inside the Next.js flight. */
export function parseDeelListing(html: string): RawJob[] {
  const marker = html.indexOf("career-job-listing")
  if (marker < 0) return []
  const jobsKey = html.indexOf('\\"jobs\\":', marker)
  const arrayStart = jobsKey < 0 ? -1 : html.indexOf("[", jobsKey)
  const arrayEnd = arrayStart < 0 ? -1 : html.indexOf(',\\"jobsCount\\"', arrayStart)
  if (arrayStart < 0 || arrayEnd < 0) return []
  let decoded: string
  try {
    decoded = JSON.parse('"' + html.slice(arrayStart, arrayEnd) + '"') as string
  } catch {
    return []
  }
  let rows: unknown
  try {
    rows = JSON.parse(decoded) as unknown
  } catch {
    return []
  }
  const jobs: RawJob[] = []
  for (const item of asArray(rows)) {
    const row = asRecord(asRecord(item)?.attributes)
    if (!row || row.is_listed === false) continue
    const id = str(row.ashby_id)
    const title = str(row.title)
    if (!id || !title) continue
    const places = asArray(row.all_locations).map((place) => str(place))
    const location = formatLocation(places.length > 0 ? places : [str(row.location_name)])
    jobs.push({
      externalId: id,
      title,
      company: "Deel",
      location,
      url: deelJobUrl(id),
      postedAt: toIso(row.ashby_published_date),
      salary: deelSalary(str(row.compensation_tier_summary)),
    })
  }
  return jobs
}

function jsonStringAt(text: string, start: number): string | null {
  if (text[start] !== '"') return null
  for (let i = start + 1; i < text.length; i++) {
    const char = text[i]
    if (char === "\\") {
      i += 1
      continue
    }
    if (char === '"') {
      try {
        return JSON.parse(text.slice(start, i + 1)) as string
      } catch {
        return null
      }
    }
  }
  return null
}

function flightOf(html: string): string | null {
  const marker = "self.__next_f.push([1,"
  const at = html.indexOf(marker)
  if (at < 0) return null
  const quote = html.indexOf('"', at + marker.length)
  if (quote < 0) return null
  return jsonStringAt(html, quote)
}

/** The posting body is an HTML row in the flight; the id is `full_job_description`. */
export function readDeelDescription(html: string): string | undefined {
  const flight = flightOf(html)
  if (!flight) return undefined
  const ref = /full_job_description":"\$([0-9a-f]+)"/.exec(flight)?.[1]
  if (!ref) return undefined
  const row = new RegExp(`(?:^|\\n)${ref}:T\\d+,`).exec(flight)
  if (!row) return undefined
  const rest = flight.slice(row.index + row[0].length)
  const end = /<\/(?:ul|ol|p|div)>(?=[0-9a-f]+:)/.exec(rest)
  const body = end ? rest.slice(0, end.index + end[0].length) : rest
  return clipDescription(body)
}

export async function fetchDeelDescription(jobUrl: string): Promise<string | null> {
  const detail = deelDetailUrl(jobUrl)
  if (!detail) return null
  try {
    return readDeelDescription(await fetchText(detail)) ?? null
  } catch {
    return null
  }
}

export const deel: Adapter = {
  provider: "deel",
  kind: "company",
  detect(url) {
    const host = url.hostname.toLowerCase()
    if ((host === "www.deel.com" || host === "deel.com") && url.pathname.startsWith("/careers")) return "deel"
    if (host === "jobs.deel.com" && (url.pathname === "/deel" || url.pathname.startsWith("/deel/"))) return "deel"
    return null
  },
  async fetchJobs() {
    const html = await fetchText(CAREERS)
    const jobs = parseDeelListing(html)
    if (jobs.length === 0) throw new Error("deel: no jobs in the careers page")
    return jobs
  },
}
