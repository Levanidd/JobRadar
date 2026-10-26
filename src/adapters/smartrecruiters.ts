import { asArray, asRecord, fetchJson, str } from "../http"
import type { Adapter, RawJob } from "../types"
import { formatLocation } from "./location"

export function parseSmartRecruiters(payload: unknown): RawJob[] {
  const root = asRecord(payload)
  const jobs: RawJob[] = []
  for (const item of asArray(root?.content)) {
    const row = asRecord(item)
    if (!row) continue
    const id = str(row.id)
    const title = str(row.name)
    const company = asRecord(row.company)
    const identifier = str(company?.identifier) ?? "company"
    if (!id || !title) continue
    const loc = asRecord(row.location)
    const primary = str(loc?.fullLocation) ?? [str(loc?.city), str(loc?.country)].filter(Boolean).join(", ")
    const extra = asArray(row.locations).map((item) => {
      const place = asRecord(item)
      return str(place?.fullLocation) ?? [str(place?.city), str(place?.country)].filter(Boolean).join(", ")
    })
    const location = formatLocation([primary, ...extra], { remote: loc?.remote === true })
    jobs.push({
      externalId: id,
      title,
      company: str(company?.name),
      location,
      url: `https://jobs.smartrecruiters.com/${identifier}/${id}`,
      postedAt: str(row.releasedDate),
    })
  }
  return jobs
}

export const smartrecruiters: Adapter = {
  provider: "smartrecruiters",
  kind: "company",
  detect(url) {
    if (url.hostname === "careers.smartrecruiters.com" || url.hostname === "jobs.smartrecruiters.com") {
      return url.pathname.split("/").filter(Boolean)[0] ?? null
    }
    return null
  },
  async fetchJobs(token) {
    const all: RawJob[] = []
    let offset = 0
    for (let i = 0; i < 10; i += 1) {
      const json = await fetchJson(
        `https://api.smartrecruiters.com/v1/companies/${token}/postings?limit=100&offset=${offset}`,
      )
      const batch = parseSmartRecruiters(json)
      all.push(...batch)
      if (batch.length < 100) break
      offset += 100
    }
    return all
  },
}
