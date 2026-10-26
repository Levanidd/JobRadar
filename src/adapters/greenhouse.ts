import { asArray, asRecord, fetchJson, str } from "../http"
import { clipDescription } from "../prefilter"
import { toSalary } from "../salary"
import type { Adapter, RawJob, Salary } from "../types"
import { formatLocation } from "./location"

function greenhouseSalary(row: Record<string, unknown>): Salary | undefined {
  for (const item of asArray(row.pay_input_ranges)) {
    const range = asRecord(item)
    if (!range) continue
    const salary = toSalary({
      min: range.min_cents ?? range.min,
      max: range.max_cents ?? range.max,
      currency: range.currency_type ?? range.currency,
      period: range.interval,
      cents: range.min_cents != null || range.max_cents != null,
    })
    if (salary) return salary
  }
  return undefined
}

export function parseGreenhouse(payload: unknown, fallbackCompany?: string): RawJob[] {
  const root = asRecord(payload)
  const jobs: RawJob[] = []
  for (const item of asArray(root?.jobs)) {
    const row = asRecord(item)
    if (!row) continue
    const id = str(row.id)
    const title = str(row.title)
    const url = str(row.absolute_url)
    if (!id || !title || !url) continue
    const loc = asRecord(row.location)
    const offices = asArray(row.offices).map((office) => str(asRecord(office)?.name) ?? str(office))
    jobs.push({
      externalId: id,
      title,
      company: str(row.company_name) ?? fallbackCompany,
      location: formatLocation([str(loc?.name), ...offices]),
      url,
      description: clipDescription(str(row.content)),
      postedAt: str(row.updated_at) ?? str(row.first_published),
      salary: greenhouseSalary(row),
    })
  }
  return jobs
}

export const greenhouse: Adapter = {
  provider: "greenhouse",
  kind: "company",
  detect(url) {
    if (!/^(?:job-)?boards\.(?:eu\.)?greenhouse\.io$/.test(url.hostname)) return null
    const token = url.pathname.split("/").filter(Boolean)[0]
    if (token === "embed") return url.searchParams.get("for")
    return token ?? null
  },
  async fetchJobs(token) {
    const json = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`)
    return parseGreenhouse(json, token)
  },
}
