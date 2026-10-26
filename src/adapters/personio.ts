import { XMLParser } from "fast-xml-parser"

import { asArray, asRecord, fetchJson, fetchText, str, type HttpError } from "../http"
import { clipDescription } from "../prefilter"
import type { Adapter, RawJob } from "../types"
import { formatLocation } from "./location"

const parser = new XMLParser({ ignoreAttributes: false, cdataPropName: "__cdata" })

function officesOf(value: unknown): Array<string | undefined> {
  if (Array.isArray(value)) return value.flatMap((item) => officesOf(item))
  return [textOf(value) ?? str(value)]
}

function textOf(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>
    if (typeof rec["#text"] === "string") return rec["#text"]
    if (typeof rec.__cdata === "string") return rec.__cdata
  }
  return undefined
}

export function parsePersonio(xml: string, fallbackCompany?: string): RawJob[] {
  const doc = parser.parse(xml) as Record<string, unknown>
  const root = doc["workzag-jobs"] as Record<string, unknown> | undefined
  if (!root) return []
  const raw = root.position
  const positions = Array.isArray(raw) ? raw : raw ? [raw] : []
  const jobs: RawJob[] = []
  for (const item of positions) {
    if (!item || typeof item !== "object") continue
    const row = item as Record<string, unknown>
    const id = str(row.id)
    const title = textOf(row.name) ?? str(row.name)
    if (!id || !title) continue
    const descriptions = row.jobDescriptions as Record<string, unknown> | undefined
    const descNodes = descriptions?.jobDescription
    const descList = Array.isArray(descNodes) ? descNodes : descNodes ? [descNodes] : []
    const description = descList
      .map((node) => textOf((node as Record<string, unknown>).value) ?? "")
      .join("\n")
    jobs.push({
      externalId: id,
      title,
      company: fallbackCompany,
      location: formatLocation(officesOf(row.offices ?? row.office)),
      url: `https://${fallbackCompany ?? "board"}.jobs.personio.de/job/${id}`,
      description: clipDescription(description),
      postedAt: str(row.createdAt),
    })
  }
  return jobs
}

/** The board page's own search feed: same postings, but no description. */
export function parsePersonioSearch(payload: unknown, company: string): RawJob[] {
  const jobs: RawJob[] = []
  for (const item of asArray(payload)) {
    const row = asRecord(item)
    const id = str(row?.id)
    const title = str(row?.name)
    if (!row || !id || !title) continue
    const offices = asArray(row.offices).map((office) => str(office)).filter(Boolean)
    const summary = [str(row.department), str(row.seniority), str(row.keywords)].filter(Boolean).join(" · ")
    jobs.push({
      externalId: id,
      title,
      company,
      location: offices.length > 0 ? offices.join(", ") : str(row.office),
      url: `https://${company}.jobs.personio.de/job/${id}`,
      description: clipDescription(str(row.description) || summary),
    })
  }
  return jobs
}

export const personio: Adapter = {
  provider: "personio",
  kind: "company",
  detect(url) {
    const host = url.hostname
    const m = host.match(/^([a-z0-9-]+)\.jobs\.personio\.(de|com)$/i)
    return m?.[1] ?? null
  },
  async fetchJobs(token) {
    try {
      const xml = await fetchText(`https://${token}.jobs.personio.de/xml?language=en`)
      return parsePersonio(xml, token)
    } catch (error) {
      // A company can switch the XML export off while its board stays public.
      if ((error as HttpError).status !== 404) throw error
      const json = await fetchJson(`https://${token}.jobs.personio.de/search.json`)
      return parsePersonioSearch(json, token)
    }
  },
}
