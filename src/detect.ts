import { detectToken, getAdapter } from "./adapters"
import { fetchResponse } from "./http"
import { BROWSER_LIKE_USER_AGENT } from "./vendor/career-ops/_http.mjs"
import type { AdapterEnv, RawJob } from "./types"

/** rss is a company adapter too, but its token is a feed URL — a bare slug means nothing there. */
const GUESSABLE = ["greenhouse", "lever", "ashby", "personio", "workable", "smartrecruiters", "recruitee"]

const HOST_NOISE = new Set(["www", "careers", "career", "jobs", "job", "apply", "hiring", "join"])

/**
 * Branded Avature boards live at `/<locale>/<section>/SearchJobs`, not on
 * `*.avature.net`. The listing URL is that path with the query dropped.
 */
export function avatureBoard(url: string): string {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname.replace(/\/+$/, "")
    const cut = path.search(/\/SearchJobs\b/i)
    const base = cut >= 0 ? path.slice(0, cut) : path
    return `${parsed.origin}${base}/SearchJobs`
  } catch {
    return url
  }
}

/** Milch & Zucker renders the board on the company host and calls its own API. */
export function gjbBoard(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}

/**
 * The board the SuccessFactors adapter fetches. Drops the search page, a
 * saved-search category and the query string, and keeps a brand path
 * (`/Bluebeam`) that several tenants share one host through.
 */
export function successfactorsBoard(url: string): string {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname
      .replace(/\/go\/[^/]+\/\d+(?:\/\d+)?\/?$/i, "")
      .replace(/\/(?:search|tile-search-results|services\/recruiting\/v1\/jobs)\/?$/i, "")
      .replace(/\/+$/, "")
    return parsed.origin + path
  } catch {
    return url
  }
}

const ATS_MARKERS: {
  re: RegExp
  provider: string
  group: number
  useUrl?: boolean
  build?: (match: RegExpMatchArray) => string
  /** Turns the page URL into the token the adapter fetches. */
  board?: (url: string) => string
}[] = [
  // Platforms that host a page on someone else's domain come first: a fund's
  // talent network or a corporate group's site links the Greenhouse and Lever
  // boards of the companies it lists, and those must not win. The page URL is
  // the token; the adapter takes it from there.
  { re: /cdn\.radancy\.(?:eu|com)|tbcdn\.talentbrew\.com/i, provider: "radancy", group: 0, useUrl: true },
  { re: /cdn\.getro\.com/i, provider: "getro", group: 0, useUrl: true },
  { re: /"board"\s*:\s*\{\s*"id"\s*:\s*"[a-z0-9_-]+"/i, provider: "consider", group: 0, useUrl: true },
  // A branded RMK host (jobs.dkb.de) never says successfactors in its own URL.
  // The page loads the SuccessFactors runtime, and that page is the board.
  {
    re: /https?:\/\/[a-z0-9.-]*successfactors\.(?:eu|com)\b|jobs2web\.com/i,
    provider: "successfactors",
    group: 0,
    useUrl: true,
    board: successfactorsBoard,
  },
  // A branded Avature host (careers.unicredit.eu) loads its portal runtime.
  // The board is that page's SearchJobs path, not the script URL.
  {
    re: /\/ASSET\/portal\//i,
    provider: "avature",
    group: 0,
    useUrl: true,
    board: avatureBoard,
  },
  // Milch & Zucker (jobs.commerzbank.com) names its client script, and the
  // API host is only inside that script. The careers origin is the token.
  {
    re: /gjb_scripts\.js/i,
    provider: "gjb",
    group: 0,
    useUrl: true,
    board: gjbBoard,
  },
  // Branded career sites list their openings but link each one to the Workday
  // posting; the tenant, instance and site in that link are the whole board.
  {
    re: /https?:\/\/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?(?!wday\/)([a-z0-9_-]+)/i,
    provider: "workday",
    group: 0,
    build: (m) => `https://${m[1].toLowerCase()}.${m[2].toLowerCase()}.myworkdayjobs.com/${m[3]}`,
  },
  // The embed script is served both as `job_board?for=` and `job_board/js?for=`.
  // EU-hosted boards live under `boards.eu.` / `job-boards.eu.`; the board API answers for both.
  {
    re: /boards\.(?:eu\.)?greenhouse\.io\/embed\/job_board(?:\/js)?\?for=([a-z0-9_-]+)/i,
    provider: "greenhouse",
    group: 1,
  },
  { re: /job-boards\.(?:eu\.)?greenhouse\.io\/(?!embed\b)([a-z0-9_-]+)/i, provider: "greenhouse", group: 1 },
  { re: /boards\.(?:eu\.)?greenhouse\.io\/(?!embed\b)([a-z0-9_-]+)/i, provider: "greenhouse", group: 1 },
  { re: /jobs\.lever\.co\/([a-z0-9_-]+)/i, provider: "lever", group: 1 },
  // The board name is the first path segment, and Ashby allows a dot in it
  // (`taxfix.com`, `checkout.com`). Stopping at the dot fetches a board that 404s.
  { re: /api\.ashbyhq\.com\/posting-api\/job-board\/([a-z0-9_-]+(?:\.[a-z0-9_-]+)*)/i, provider: "ashby", group: 1 },
  { re: /jobs\.ashbyhq\.com\/([a-z0-9_-]+(?:\.[a-z0-9_-]+)*)/i, provider: "ashby", group: 1 },
  { re: /([a-z0-9-]+)\.jobs\.personio\.(?:de|com)/i, provider: "personio", group: 1 },
  { re: /apply\.workable\.com\/([a-z0-9_-]+)/i, provider: "workable", group: 1 },
  { re: /careers\.smartrecruiters\.com\/([a-z0-9_-]+)/i, provider: "smartrecruiters", group: 1 },
  { re: /([a-z0-9-]+)\.recruitee\.com/i, provider: "recruitee", group: 1 },
  { re: /([a-z0-9-]+)\.breezy\.hr/i, provider: "breezy", group: 0, useUrl: true },
  { re: /([a-z0-9-]+)\.bamboohr\.com/i, provider: "bamboohr", group: 0, useUrl: true },
  { re: /([a-z0-9-]+)\.pinpointhq\.com/i, provider: "pinpoint", group: 0, useUrl: true },
  { re: /ats\.rippling\.com\/([a-z0-9-]+)/i, provider: "rippling", group: 0, useUrl: true },
  { re: /jobs\.gem\.com\/([a-z0-9_-]+)/i, provider: "gem", group: 0, useUrl: true },
  { re: /([a-z0-9-]+)\.eightfold\.ai/i, provider: "eightfold", group: 0, useUrl: true },
  { re: /([a-z0-9-]+)\.app\.beesite\.de/i, provider: "beesite", group: 0, useUrl: true },
]

export type DetectResult = {
  ats: string | null
  token: string | null
  ok: boolean
  jobs_found: number
  sample: string[]
  /** True when the board was found by guessing the slug rather than reading it off the page. */
  guessed: boolean
}

type Found = { provider: string; token: string; jobs?: RawJob[] }

export function matchMarkers(haystack: string, url: string): { provider: string; token: string } | null {
  for (const marker of ATS_MARKERS) {
    const m = haystack.match(marker.re)
    if (!m) continue
    const raw = marker.build ? marker.build(m) : marker.useUrl ? url : m[marker.group]
    const token = raw && marker.board ? marker.board(raw) : raw
    if (token) return { provider: marker.provider, token }
  }
  return null
}

async function collectPageText(res: Response): Promise<string> {
  if (typeof HTMLRewriter === "undefined") {
    return res.text()
  }
  const chunks: string[] = []
  // Some boards name their vendor only inside an inlined config blob, so script
  // bodies count too — bounded, since one of those blobs can be a megabyte.
  let budget = 512 * 1024
  const rewriter = new HTMLRewriter()
    .on("a", {
      element(el) {
        chunks.push(el.getAttribute("href") ?? "")
      },
    })
    .on("iframe", {
      element(el) {
        chunks.push(el.getAttribute("src") ?? "")
      },
    })
    .on("link", {
      element(el) {
        chunks.push(el.getAttribute("href") ?? "")
      },
    })
    .on("script", {
      element(el) {
        chunks.push(el.getAttribute("src") ?? "")
      },
      text(chunk) {
        if (budget <= 0) return
        budget -= chunk.text.length
        chunks.push(chunk.text)
      },
    })
    .on("div", {
      element(el) {
        chunks.push(el.getAttribute("data-url") ?? "")
      },
    })
  await rewriter.transform(res).arrayBuffer()
  return chunks.join("\n")
}

function slugCandidates(url: URL): string[] {
  const labels = url.hostname.toLowerCase().split(".").filter(Boolean)
  // Everything but the TLD is fair game; `www.` and careers-y subdomains never name the company.
  const name = labels.slice(0, -1).find((label) => !HOST_NOISE.has(label))
  if (!name || !/^[a-z0-9-]+$/.test(name)) return []
  const compact = name.replace(/-/g, "")
  return compact === name ? [name] : [name, compact]
}

async function guessFromDomain(url: URL, env?: AdapterEnv): Promise<Found | null> {
  for (const token of slugCandidates(url)) {
    const hits = await Promise.all(
      GUESSABLE.map(async (provider) => {
        try {
          const jobs = await getAdapter(provider).fetchJobs(token, env)
          return jobs.length > 0 ? { provider, token, jobs } : null
        } catch {
          return null
        }
      }),
    )
    // Boards that exist but are empty look identical to typos, so only a populated one counts.
    const hit = hits.find((item) => item !== null)
    if (hit) return hit
  }
  return null
}

async function jobsFor(found: Found, env?: AdapterEnv): Promise<RawJob[] | null> {
  if (found.jobs) return found.jobs
  try {
    return await getAdapter(found.provider).fetchJobs(found.token, env)
  } catch {
    return null
  }
}

async function probe(url: string): Promise<{ provider: string; token: string } | null> {
  try {
    const parsed = new URL(url)
    const direct = detectToken(parsed)
    if (direct) return direct
    let res = await fetchResponse(url, { headers: { Accept: "text/html" } })
    // Fund talent networks sit behind bot management that refuses our agent
    // outright; the board itself is public once we knock like a browser.
    if (res.status === 403) {
      res = await fetchResponse(url, {
        headers: { Accept: "text/html", "User-Agent": BROWSER_LIKE_USER_AGENT },
      })
    }
    if (!res.ok) return null
    const text = await collectPageText(res)
    return matchMarkers(text, url)
  } catch {
    return null
  }
}

const MISS: DetectResult = { ats: null, token: null, ok: false, jobs_found: 0, sample: [], guessed: false }

export async function detectUrl(input: string, env?: AdapterEnv): Promise<DetectResult> {
  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    return MISS
  }

  let found: Found | null = detectToken(parsed)
  if (!found) {
    found = await probe(parsed.href)
  }
  if (!found) {
    for (const path of ["/careers", "/jobs", "/en/careers"]) {
      const guess = new URL(path, parsed.origin).href
      found = await probe(guess)
      if (found) break
    }
  }

  let jobs = found ? await jobsFor(found, env) : null
  let guessed = false

  // Pages that render listings client-side leave no ATS link, and a marker can still yield a
  // token that fetches nothing. Both cases are better served by guessing the slug than by giving up.
  if (!jobs?.length) {
    const fallback = await guessFromDomain(parsed, env)
    if (fallback) {
      found = fallback
      jobs = fallback.jobs ?? null
      guessed = true
    }
  }

  if (!found) {
    return MISS
  }

  return {
    ats: found.provider,
    token: found.token,
    ok: (jobs?.length ?? 0) > 0,
    jobs_found: jobs?.length ?? 0,
    sample: (jobs ?? []).slice(0, 3).map((job) => job.title),
    guessed,
  }
}
