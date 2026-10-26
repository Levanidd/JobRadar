import { asArray, asRecord, fetchJson, str } from "../http"
import { clipDescription } from "../prefilter"
import type { Adapter, RawJob } from "../types"
import { formatLocation } from "./location"

export function parseRecruitee(payload: unknown, fallbackCompany?: string): RawJob[] {
  const root = asRecord(payload)
  const jobs: RawJob[] = []
  for (const item of asArray(root?.offers)) {
    const row = asRecord(item)
    if (!row) continue
    const id = str(row.id) ?? str(row.slug)
    const title = str(row.title)
    const url = str(row.careers_url) ?? str(row.url)
    if (!id || !title || !url) continue
    const loc = asRecord(row.location)
    const cities = asArray(row.locations).map((item) => str(asRecord(item)?.city) ?? str(item))
    const workplace = row.hybrid === true ? "Hybrid" : row.remote === true ? "Remote" : undefined
    jobs.push({
      externalId: id,
      title,
      company: fallbackCompany,
      location: formatLocation([str(loc?.city) ?? str(row.location), ...cities], { workplace }),
      url,
      description: clipDescription(str(row.description)),
      postedAt: str(row.published_at),
    })
  }
  return jobs
}

export const recruitee: Adapter = {
  provider: "recruitee",
  kind: "company",
  detect(url) {
    const m = url.hostname.match(/^([a-z0-9-]+)\.recruitee\.com$/i)
    return m?.[1] ?? null
  },
  async fetchJobs(token) {
    const json = await fetchJson(`https://${token}.recruitee.com/api/offers/`)
    return parseRecruitee(json, token)
  },
}
