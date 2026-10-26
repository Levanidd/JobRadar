import { asArray, asRecord, fetchJson, str } from "../http"
import { clipDescription } from "../prefilter"
import { toSalary } from "../salary"
import type { Adapter, RawJob, Salary } from "../types"
import { formatLocation } from "./location"

function ashbySalary(row: Record<string, unknown>): Salary | undefined {
  const compensation = asRecord(row.compensation)
  if (!compensation) return undefined
  for (const tier of asArray(compensation.compensationTiers)) {
    const item = asRecord(tier)
    if (!item) continue
    for (const component of asArray(item.components)) {
      const part = asRecord(component)
      if (!part) continue
      const kind = str(part.compensationType)?.toLowerCase() ?? ""
      if (kind && kind !== "salary" && kind !== "base") continue
      const salary = toSalary({
        min: part.minValue,
        max: part.maxValue,
        currency: part.currencyCode,
        period: part.interval,
      })
      if (salary) return salary
    }
  }
  return undefined
}

export function parseAshby(payload: unknown, fallbackCompany?: string): RawJob[] {
  const root = asRecord(payload)
  const jobs: RawJob[] = []
  for (const item of asArray(root?.jobs)) {
    const row = asRecord(item)
    if (!row) continue
    const id = str(row.id)
    const title = str(row.title)
    const url = str(row.jobUrl) ?? str(row.applyUrl)
    if (!id || !title || !url) continue
    const secondary = asArray(row.secondaryLocations).map((item) => {
      const place = asRecord(item)
      return str(place?.location) ?? str(item)
    })
    const location = formatLocation([str(row.location), ...secondary], {
      workplace: str(row.workplaceType),
      remote: row.isRemote === true,
    })
    jobs.push({
      externalId: id,
      title,
      company: fallbackCompany,
      location,
      url,
      description: clipDescription(str(row.descriptionHtml) ?? str(row.descriptionPlain)),
      postedAt: str(row.publishedAt),
      salary: ashbySalary(row),
    })
  }
  return jobs
}

export const ashby: Adapter = {
  provider: "ashby",
  kind: "company",
  detect(url) {
    if (url.hostname === "jobs.ashbyhq.com") {
      return url.pathname.split("/").filter(Boolean)[0] ?? null
    }
    return null
  },
  async fetchJobs(token) {
    const json = await fetchJson(
      `https://api.ashbyhq.com/posting-api/job-board/${token}?includeCompensation=true`,
    )
    return parseAshby(json, token)
  },
}
