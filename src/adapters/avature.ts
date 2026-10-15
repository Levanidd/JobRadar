import avatureProvider, { parseArticles } from "../vendor/career-ops/avature.mjs"
import { fetchText, toIso } from "../http"
import type { Adapter, RawJob } from "../types"
import { fromCareerOps, labelFromUrl } from "./career-ops"

const classic = fromCareerOps(avatureProvider, {
  kind: "company",
  entry: (token) => ({ name: labelFromUrl(token), careers_url: token, api: token, max_pages: 5 }),
})

/** How many listing pages to open at once. A board of ~600 is ~40 pages. */
const PAGE_CONCURRENCY = 24
/** Stop a branded board that never prints its total, so a hop stays inside the fetch budget. */
const MAX_PAGES = 80

function classicHost(token: string): boolean {
  try {
    const host = new URL(token).hostname.toLowerCase()
    return host === "avature.net" || host.endsWith(".avature.net")
  } catch {
    return false
  }
}

/** Page length is the smallest `jobOffset` link; the total sits in "of N results". */
function pagePlan(html: string): { total: number | null; step: number } {
  const totalMatch = html.match(/of\s*<span class="legend--bold">\s*([\d,]+)\s*<\/span>\s*results/i)
  const total = totalMatch ? Number(totalMatch[1]!.replace(/,/g, "")) : null
  const offsets = [...html.matchAll(/[?&]jobOffset=(\d+)/g)].map((match) => Number(match[1])).filter((n) => n > 0)
  const step = offsets.length > 0 ? Math.min(...offsets) : 15
  return { total: total && total > 0 ? total : null, step }
}

/** UniCredit prints the city in a world icon the shared article parser does not read. */
function placesById(html: string): Map<string, string> {
  const places = new Map<string, string>()
  const re = /<article class="article article--(?:result|jobs)\b[^"]*"[\s\S]*?<\/article>/g
  for (const match of html.matchAll(re)) {
    const block = match[0]
    const id = block.match(/\/JobDetail\/[^/]*\/(\d+)/)?.[1]
    const icon = block.match(/job-info-icon_world">([\s\S]*?)<\/span>/i)
    if (!id || !icon) continue
    const place = icon[1]!.replace(/<[^>]+>/g, " ").replace(/\s*,\s*/g, ", ").replace(/\s+/g, " ").trim()
    if (place) places.set(id, place)
  }
  return places
}

function pageUrl(search: URL, offset: number): string {
  const url = new URL(search.href)
  url.searchParams.set("jobOffset", String(offset))
  return url.href
}

async function mapPool<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  async function worker() {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      await run(items[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
}

/**
 * Branded tenants (careers.unicredit.eu) serve the whole list, often hundreds
 * of postings at 15 a page. The vendored walker steps by 6 and pauses between
 * pages, which cannot finish inside a hop, so these boards are read in parallel.
 */
async function fetchBranded(token: string): Promise<RawJob[]> {
  const search = new URL(token)
  if (search.protocol !== "https:") throw new Error(`avature: URL must use HTTPS: ${token}`)
  const jobs: RawJob[] = []
  const seen = new Set<string>()
  const take = (html: string) => {
    const places = placesById(html)
    for (const row of parseArticles(html, search.origin)) {
      if (seen.has(row.id)) continue
      seen.add(row.id)
      jobs.push({
        externalId: row.id,
        title: row.title,
        location: row.location || places.get(row.id) || undefined,
        url: row.url,
        postedAt: toIso(row.postedAt),
      })
    }
  }

  const first = await fetchText(pageUrl(search, 0))
  if (!parseArticles(first, search.origin).length && /\/JobDetail\//i.test(first)) {
    throw new Error(`avature: ${token} still contains JobDetail links but no article could be parsed`)
  }
  take(first)
  const { total, step } = pagePlan(first)
  const pages = Math.min(MAX_PAGES, total ? Math.ceil(total / step) : 1)
  const offsets = Array.from({ length: Math.max(0, pages - 1) }, (_, index) => (index + 1) * step)
  await mapPool(offsets, PAGE_CONCURRENCY, async (offset) => {
    take(await fetchText(pageUrl(search, offset)))
  })
  return jobs
}

export const avature: Adapter = {
  ...classic,
  async fetchJobs(token, env) {
    if (classicHost(token)) return classic.fetchJobs(token, env)
    return fetchBranded(token)
  },
}
