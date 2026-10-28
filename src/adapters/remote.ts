import { asArray, asRecord, fetchJson, str, toIso } from "../http"
import { clipDescription } from "../prefilter"
import { toSalary } from "../salary"
import type { Adapter, RawJob } from "../types"

/**
 * Remote's own board. `GET /api/public/jobs` is one page of every open role;
 * the posting body lives on the job, in `advert_sections`, and is fetched
 * only for roles that reach scoring.
 */
const HOST = "apply.remote.com"
const LIST = `https://${HOST}/api/public/jobs`
const COMPANY = "Remote"

const SKIP_SECTION = /^(about(?:[\s_-]*remote)?|conclusion)$/i

export function remoteJobUrl(id: string): string {
  return `https://${HOST}/jobs/${id}`
}

export function remoteDetailUrl(jobUrl: string): string | null {
  try {
    const url = new URL(jobUrl)
    if (url.hostname !== HOST) return null
    const id = /^\/jobs\/([0-9a-f-]{36})$/i.exec(url.pathname)?.[1]
    return id ? `${LIST}/${id}` : null
  } catch {
    return null
  }
}

/** Their advert is a ProseMirror-ish tree: paragraphs, headings, bullets. */
export function remoteDocText(node: unknown): string {
  if (Array.isArray(node)) return node.map(remoteDocText).map((part) => part.trim()).filter(Boolean).join("\n")
  const row = asRecord(node)
  if (!row) return ""
  const text = str(row.text)?.trim() ?? ""
  const inner = remoteDocText(row.content)
  const type = str(row.type)
  if (type === "bulleted") {
    const line = inner || text
    return line
      ? line
          .split("\n")
          .map((part) => `- ${part.replace(/^- /, "")}`)
          .join("\n")
      : ""
  }
  if (text && inner) return `${text}\n${inner}`
  return text || inner
}

export function readRemoteDescription(payload: unknown): string | undefined {
  const root = asRecord(payload)
  const job = asRecord(root?.job) ?? root
  if (!job) return undefined
  const parts: string[] = []
  for (const section of asArray(job.advert_sections)) {
    const row = asRecord(section)
    if (!row) continue
    const heading = str(row.heading) ?? str(row.key) ?? ""
    if (SKIP_SECTION.test(heading.trim())) continue
    const text = remoteDocText(row.doc).trim()
    if (!text) continue
    parts.push(heading ? `${heading}\n${text}` : text)
  }
  const requirements = remoteDocText(job.requirements).trim()
  if (requirements) parts.push(requirements)
  return clipDescription(parts.join("\n\n") || undefined)
}

function salaryOf(row: Record<string, unknown>) {
  const pay = asRecord(row.pay)
  const band = asRecord(asArray(pay?.rows)[0])
  if (!band) return undefined
  return toSalary({ min: band.min, max: band.max, currency: band.currency })
}

export function parseRemote(payload: unknown): RawJob[] {
  const root = asRecord(payload)
  const jobs: RawJob[] = []
  for (const item of asArray(root?.jobs)) {
    const row = asRecord(item)
    if (!row) continue
    if (str(row.status) !== "open" || row.accepting_applications === false) continue
    const id = str(row.public_id)
    const title = str(row.title)
    if (!id || !title) continue
    jobs.push({
      externalId: id,
      title,
      company: COMPANY,
      location: str(row.location),
      url: remoteJobUrl(id),
      postedAt: toIso(row.opened_at),
      salary: salaryOf(row),
    })
  }
  return jobs
}

export async function fetchRemoteDescription(jobUrl: string): Promise<string | null> {
  const detail = remoteDetailUrl(jobUrl)
  if (!detail) return null
  try {
    return readRemoteDescription(await fetchJson(detail)) ?? null
  } catch {
    return null
  }
}

export const remote: Adapter = {
  provider: "remote",
  kind: "company",
  detect(url) {
    if (url.hostname === HOST) return "remote"
    if (url.hostname === "remote.com" && /^\/(?:openings|careers|jobs)(?:\/|$)/i.test(url.pathname)) return "remote"
    return null
  },
  async fetchJobs() {
    const json = await fetchJson(LIST)
    const root = asRecord(json)
    if (!root || !Array.isArray(root.jobs)) throw new Error("remote: expected { jobs: [...] }")
    return parseRemote(json)
  },
}
