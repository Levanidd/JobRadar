import softgardenProvider from "../vendor/career-ops/softgarden.mjs"
import { fetchResponse } from "../http"
import { fromCareerOps, labelFromUrl } from "./career-ops"

const LANG = /^[a-z]{2}$/

/**
 * Widget URLs to try, most specific first. A path that already names a
 * language, or is the widget itself, is used as-is. A posting link does not
 * name one, and German is not a safe default: some boards only publish /en/.
 */
export function softgardenWidgetCandidates(raw: string): string[] {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return []
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return []
  const host = url.hostname.toLowerCase()
  if (host !== "softgarden.io" && !host.endsWith(".softgarden.io")) return []
  const origin = url.origin
  if (/\/widgets\/jobs\/?$/.test(url.pathname)) return [`${origin}${url.pathname.replace(/\/$/, "")}`]
  const pathLang = url.pathname.match(/^\/([a-z]{2})(\/|$)/)?.[1]
  if (pathLang) return [`${origin}/${pathLang}/widgets/jobs`]
  const queryLang = url.searchParams.get("l")?.toLowerCase()
  const langs = [queryLang, "en", "de"].filter((lang): lang is string => Boolean(lang && LANG.test(lang)))
  return [...new Set(langs)].map((lang) => `${origin}/${lang}/widgets/jobs`)
}

/** The first widget that actually lists jobs. A bare 200 with no list is kept as a fallback. */
export async function resolveSoftgardenWidget(raw: string): Promise<string> {
  const candidates = softgardenWidgetCandidates(raw)
  if (candidates.length === 0) throw new Error("softgarden: cannot resolve widget URL")
  if (candidates.length === 1) return candidates[0]
  let fallback: string | null = null
  for (const widget of candidates) {
    const res = await fetchResponse(widget, { headers: { accept: "text/html" } })
    if (!res.ok) {
      await res.body?.cancel()
      continue
    }
    const html = await res.text()
    if (html.includes('class="matchElement"')) return widget
    fallback ??= widget
  }
  if (fallback) return fallback
  throw new Error(`softgarden: no jobs widget at ${candidates.join(" or ")}`)
}

export const softgarden = fromCareerOps(softgardenProvider, {
  kind: "company",
  entry: async (token) => {
    const widget = await resolveSoftgardenWidget(token)
    return { name: labelFromUrl(token), careers_url: widget, api: widget }
  },
})
