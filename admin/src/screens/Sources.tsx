import { useCallback, useMemo, useState } from "react"

import { api } from "../api"
import { useAction, useApp, useLoader } from "../app-context"
import { Age, Count, Empty, Skeletons } from "../components/common"
import { SortHeader } from "../components/SortHeader"
import { getLang, useT } from "../i18n"
import { oneOf, text, usePersistentState } from "../persist"
import type { Source, Tier } from "../types"

const ATS_SUBDOMAINS = new Set(["jobs", "boards", "job-boards", "apply", "careers"])

const SLUG = /^[a-z0-9][a-z0-9._-]*$/i

function labelFromUrl(raw: string): string {
  try {
    const url = new URL(raw.startsWith("http") ? raw : `https://${raw}`)
    const parts = url.hostname.replace(/^www\./, "").split(".")
    const candidate = ATS_SUBDOMAINS.has(parts[0] ?? "") ? (parts[1] ?? parts[0]) : parts[0]
    const name = candidate ?? raw
    return name.charAt(0).toUpperCase() + name.slice(1)
  } catch {
    return raw
  }
}

function parseBulkUrls(raw: string): { urls: string[]; leftover: string[] } {
  const urls: string[] = []
  const leftover: string[] = []
  const seen = new Set<string>()
  for (const line of raw.split(/\n+/)) {
    const pieces = line
      .split(/,\s+(?=https?:\/\/|\S+\.\S+)/i)
      .map((part) => part.replace(/^[•\-*\d.)\s]+/, "").trim())
      .filter(Boolean)
    for (const piece of pieces) {
      const href = /^https?:\/\//i.test(piece) ? piece : `https://${piece}`
      try {
        const url = new URL(href).href
        if (seen.has(url)) continue
        seen.add(url)
        urls.push(url)
      } catch {
        leftover.push(piece)
      }
    }
  }
  return { urls, leftover }
}

function prettify(slug: string): string {
  return slug
    .split(/[-_.]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

/**
 * On a shared board the host names the ATS and the path names the employer, so
 * a label taken from the domain reads "Ashbyhq" for every company on Ashby. The
 * detected token is that employer's own slug; only fall back to the domain when
 * the token is not one (Workday hands back a whole URL).
 */
function labelFor(raw: string, token: string | null): string {
  return token && SLUG.test(token) ? prettify(token) : labelFromUrl(raw)
}

type KindFilter = "" | "company" | "query"
type TierFilter = "" | Tier
type EnabledFilter = "" | "on" | "off"
type StatusFilter = "" | "ok" | "error" | "never"

type SourceSort = "label" | "provider" | "kind" | "tier" | "jobs" | "run" | "status" | "added"

const DEFAULT_DIR: Record<SourceSort, "asc" | "desc"> = {
  label: "asc",
  provider: "asc",
  kind: "asc",
  tier: "asc",
  jobs: "desc",
  run: "desc",
  status: "asc",
  added: "desc",
}

/** English has one plural. Russian keeps the three forms the counter already asks for. */
function countForms(
  t: (english: string) => string,
  one: string,
  few: string,
  many: string,
): [string, string, string] {
  if (getLang() !== "ru") return [one, many, many]
  return [t(one), t(few), t(many)]
}

function runStatus(source: Source): "ok" | "error" | "never" {
  if (source.last_ok == null) return "never"
  return Number(source.last_ok) ? "ok" : "error"
}

function compare(a: Source, b: Source, sort: SourceSort, dir: "asc" | "desc"): number {
  const sign = dir === "asc" ? 1 : -1
  let left: string | number = 0
  let right: string | number = 0
  switch (sort) {
    case "label":
      left = a.label.toLowerCase()
      right = b.label.toLowerCase()
      break
    case "provider":
      left = a.provider
      right = b.provider
      break
    case "kind":
      left = a.kind
      right = b.kind
      break
    case "tier":
      left = a.tier
      right = b.tier
      break
    case "jobs":
      left = a.active_jobs
      right = b.active_jobs
      break
    case "run":
      left = a.last_run_at ?? ""
      right = b.last_run_at ?? ""
      break
    case "status":
      left = runStatus(a)
      right = runStatus(b)
      break
    case "added":
      left = a.created_at ?? ""
      right = b.created_at ?? ""
      break
  }
  if (left < right) return -1 * sign
  if (left > right) return 1 * sign
  return b.id - a.id
}

export function Sources({ onOpenJobs }: { onOpenJobs: (source: Source) => void }) {
  const t = useT()
  const run = useAction()
  const { me, notify, sourcesTick, runningSourceId } = useApp()
  const master = me?.role === "master"
  const [sources, setSources] = useState<Source[] | null>(null)
  const [bulk, setBulk] = useState("")
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number; current: string } | null>(null)
  const [editing, setEditing] = useState<number | null>(null)
  const [draft, setDraft] = useState("")
  const [query, setQuery] = usePersistentState("sources.query", "", text)
  const [kind, setKind] = usePersistentState<KindFilter>("sources.kind", "", oneOf("", "company", "query"))
  const [tier, setTier] = usePersistentState<TierFilter>("sources.tier", "", oneOf("", "watchlist", "discovery"))
  const [enabled, setEnabled] = usePersistentState<EnabledFilter>("sources.enabled", "", oneOf("", "on", "off"))
  const [status, setStatus] = usePersistentState<StatusFilter>("sources.status", "", oneOf("", "ok", "error", "never"))
  // Providers come from the loaded sources, so they cannot be enumerated here.
  const [provider, setProvider] = usePersistentState("sources.provider", "", text)
  const [sort, setSort] = usePersistentState<SourceSort>(
    "sources.sort",
    "added",
    oneOf("label", "provider", "kind", "tier", "jobs", "run", "status", "added"),
  )
  const [dir, setDir] = usePersistentState<"asc" | "desc">("sources.dir", "desc", oneOf("asc", "desc"))

  const load = useCallback(async (silent = false) => {
    if (!silent) setSources(null)
    const result = await run(() => api.sources())
    if (result) setSources(result.sources)
  }, [run])

  useLoader(load, sourcesTick)

  const providers = useMemo(() => {
    if (!sources) return []
    return [...new Set(sources.map((item) => item.provider))].sort()
  }, [sources])

  const rows = useMemo(() => {
    if (!sources) return []
    const needle = query.trim().toLowerCase()
    return sources
      .filter((item) => {
        if (kind && item.kind !== kind) return false
        if (tier && item.tier !== tier) return false
        if (enabled === "on" && !item.enabled) return false
        if (enabled === "off" && item.enabled) return false
        if (status && runStatus(item) !== status) return false
        if (provider && item.provider !== provider) return false
        if (!needle) return true
        const hay = `${item.label} ${item.provider} ${item.token} ${item.careers_url ?? ""}`.toLowerCase()
        return hay.includes(needle)
      })
      .sort((a, b) => compare(a, b, sort, dir))
  }, [sources, query, kind, tier, enabled, status, provider, sort, dir])

  async function runBulk() {
    const parsed = parseBulkUrls(bulk)
    if (parsed.urls.length === 0 && parsed.leftover.length === 0) return
    setBulkBusy(true)
    const failed = [...parsed.leftover]
    let added = 0
    try {
      for (const [index, href] of parsed.urls.entries()) {
        setBulkProgress({ done: index, total: parsed.urls.length, current: href })
        const detected = await run(() => api.detect(href))
        if (!detected?.ats || !detected.token) {
          failed.push(href)
          continue
        }
        const created = await run(() =>
          api.createSource({
            kind: "company",
            tier: "watchlist",
            label: labelFor(href, detected.token),
            provider: detected.ats as string,
            token: detected.token as string,
            careers_url: href,
          }),
        )
        if (created) added += 1
        else failed.push(href)
      }
      setBulk(failed.join("\n"))
      notify(
        failed.length === 0
          ? t("Added {added}", { added })
          : t("Added {added} of {total}. Unrecognized links stayed in the field", {
              added,
              total: parsed.urls.length,
            }),
        failed.length === 0 ? "ok" : "error",
      )
      setSort("added")
      setDir("desc")
      await load(true)
    } finally {
      setBulkBusy(false)
      setBulkProgress(null)
    }
  }

  async function toggle(source: Source) {
    const next = source.enabled ? 0 : 1
    const result = await run(() => api.updateSource(source.id, { enabled: next }))
    if (!result) return
    setSources((prev) => prev?.map((item) => (item.id === source.id ? { ...item, enabled: next } : item)) ?? null)
  }

  async function rename(source: Source) {
    const label = draft.trim()
    setEditing(null)
    if (!label || label === source.label) return
    const result = await run(() => api.updateSource(source.id, { label }))
    if (!result) return
    setSources((prev) => prev?.map((item) => (item.id === source.id ? { ...item, label } : item)) ?? null)
  }

  async function changeTier(source: Source, next: Tier) {
    const result = await run(() => api.updateSource(source.id, { tier: next }))
    if (!result) return
    setSources((prev) => prev?.map((item) => (item.id === source.id ? { ...item, tier: next } : item)) ?? null)
  }

  async function runOne(source: Source) {
    const result = await run(() => api.runSource(source.id))
    if (!result) return
    notify(
      result.run.ok
        ? t("{label}: found {found}, {fresh} new", {
            label: source.label,
            found: result.run.jobs_found,
            fresh: result.run.jobs_new,
          })
        : t("{label}: {error}", { label: source.label, error: result.run.error ?? t("error") }),
      result.run.ok ? "ok" : "error",
    )
    await load(true)
  }

  async function remove(source: Source) {
    if (!confirm(t("Delete \"{label}\"? Application history is kept.", { label: source.label }))) return
    const result = await run(() => api.deleteSource(source.id), t("{label} deleted", { label: source.label }))
    if (!result) return
    setSources((prev) => prev?.filter((item) => item.id !== source.id) ?? null)
  }

  function sortBy(column: SourceSort) {
    if (sort === column) setDir((prev) => (prev === "asc" ? "desc" : "asc"))
    else {
      setSort(column)
      setDir(DEFAULT_DIR[column])
    }
  }

  return (
    <>
      <section className="card">
        <h3 className="card-title">{t("Add a company")}</h3>
        <p className="card-sub">
          {t(
            "A careers-page link, one or several, one per line. For each we detect the ATS and check that jobs can be read. If the ATS is not found, the link stays in the field. You can edit the label and tier in the table afterwards.",
          )}
        </p>
        <textarea
          className="textarea"
          style={{ minHeight: 96 }}
          placeholder={"https://boards.greenhouse.io/company\nhttps://jobs.lever.co/company"}
          value={bulk}
          onChange={(event) => setBulk(event.target.value)}
          disabled={bulkBusy}
        />
        {bulkProgress ? (
          <p className="muted">
            {t("{done} of {total}", { done: bulkProgress.done + 1, total: bulkProgress.total })}
            {bulkProgress.current ? ` · ${bulkProgress.current}` : ""}
          </p>
        ) : null}
        <div className="row">
          <button className="btn btn-primary btn-sm" disabled={bulkBusy || !bulk.trim()} onClick={() => void runBulk()}>
            {bulkBusy ? t("Checking…") : t("Add")}
          </button>
        </div>
      </section>

      <div className="filters">
        <input
          className="input"
          placeholder={t("Search")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select className="select" value={kind} onChange={(event) => setKind(event.target.value as KindFilter)}>
          <option value="">{t("All")}</option>
          <option value="company">{t("Company")}</option>
          <option value="query">{t("Query")}</option>
        </select>
        <select className="select" value={tier} onChange={(event) => setTier(event.target.value as TierFilter)}>
          <option value="">{t("All")}</option>
          <option value="watchlist">Watchlist</option>
          <option value="discovery">Discovery</option>
        </select>
        <select className="select" value={enabled} onChange={(event) => setEnabled(event.target.value as EnabledFilter)}>
          <option value="">{t("All")}</option>
          <option value="on">{t("Enabled")}</option>
          <option value="off">{t("Disabled")}</option>
        </select>
        <select className="select" value={status} onChange={(event) => setStatus(event.target.value as StatusFilter)}>
          <option value="">{t("All")}</option>
          <option value="ok">{t("OK")}</option>
          <option value="error">{t("Error")}</option>
          <option value="never">{t("Never run")}</option>
        </select>
        <select className="select" value={provider} onChange={(event) => setProvider(event.target.value)}>
          <option value="">{t("All")}</option>
          {providers.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      </div>

      {sources === null ? (
        <Skeletons />
      ) : sources.length === 0 ? (
        <Empty title={t("No sources")} hint={t("Migrations do not seem to have been applied yet.")} />
      ) : rows.length === 0 ? (
        <Empty title={t("Nothing found")} hint={t("Clear the filters.")} />
      ) : (
        <>
          <Count shown={rows.length} total={sources.length} forms={countForms(t, "source", "a few sources", "sources")} />
          <div className="table-wrap">
            <table className="table table-compact">
              <thead>
                <tr>
                  <SortHeader column="label" label={t("Label")} sort={sort} dir={dir} onSort={sortBy} />
                  <SortHeader column="tier" label={t("Tier")} sort={sort} dir={dir} onSort={sortBy} />
                  <SortHeader column="jobs" label={t("Jobs")} sort={sort} dir={dir} onSort={sortBy} className="col-score" />
                  <SortHeader column="run" label={t("Last run")} sort={sort} dir={dir} onSort={sortBy} className="col-date" />
                  <SortHeader column="status" label={t("Status")} sort={sort} dir={dir} onSort={sortBy} />
                  <th className="col-actions" />
                  <SortHeader column="provider" label="ATS" sort={sort} dir={dir} onSort={sortBy} />
                  <SortHeader column="kind" label={t("Type")} sort={sort} dir={dir} onSort={sortBy} />
                  <th>{t("Link")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((source) => (
                  <tr
                    key={source.id}
                    className={`${runningSourceId === source.id ? "is-busy" : ""} ${source.enabled ? "" : "is-off"}`}
                    title={source.last_error ?? undefined}
                  >
                    <td>
                      {master && editing === source.id ? (
                        <input
                          className="input"
                          value={draft}
                          autoFocus
                          onChange={(event) => setDraft(event.target.value)}
                          onBlur={() => void rename(source)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") void rename(source)
                            if (event.key === "Escape") setEditing(null)
                          }}
                        />
                      ) : master ? (
                        <button
                          type="button"
                          className="th-sort"
                          style={{ textTransform: "none", letterSpacing: 0, fontWeight: 600, color: "var(--text-primary)" }}
                          onClick={() => {
                            setEditing(source.id)
                            setDraft(source.label)
                          }}
                        >
                          {source.label}
                        </button>
                      ) : (
                        <strong>{source.label}</strong>
                      )}
                    </td>
                    <td>
                      {master ? (
                        <select
                          className="select select-inline"
                          value={source.tier}
                          onChange={(event) => void changeTier(source, event.target.value as Tier)}
                        >
                          <option value="watchlist">Watchlist</option>
                          <option value="discovery">Discovery</option>
                        </select>
                      ) : (
                        source.tier
                      )}
                    </td>
                    <td className="col-score">
                      {source.active_jobs > 0 ? (
                        <button
                          type="button"
                          className="cell-link cell-count"
                          title={t("Jobs from \"{label}\"", { label: source.label })}
                          onClick={() => onOpenJobs(source)}
                        >
                          {source.active_jobs}
                        </button>
                      ) : (
                        0
                      )}
                    </td>
                    <td className="col-date">
                      <Age value={source.last_run_at} warnAfter={7} />
                    </td>
                    <td>
                      {runStatus(source) === "never" ? (
                        <span className="badge badge-neutral">{t("never run")}</span>
                      ) : runStatus(source) === "ok" ? (
                        <span className="badge badge-positive">{t("ok")}</span>
                      ) : (
                        <span className="badge badge-negative">{t("error")}</span>
                      )}
                    </td>
                    <td className="col-actions">
                      <div className="row-tight row-btns">
                        <button className="btn btn-sm" onClick={() => void runOne(source)}>
                          {t("Run")}
                        </button>
                        {master ? (
                          <>
                            <button className="btn btn-sm" onClick={() => void toggle(source)}>
                              {source.enabled ? t("Off") : t("On")}
                            </button>
                            <button className="btn btn-danger btn-sm" onClick={() => void remove(source)}>
                              {t("Delete")}
                            </button>
                          </>
                        ) : null}
                      </div>
                    </td>
                    <td>{source.provider}</td>
                    <td>{source.kind === "query" ? t("query") : t("company")}</td>
                    <td className="col-url">
                      {source.careers_url ? (
                        <a className="mono" href={source.careers_url} target="_blank" rel="noreferrer" title={source.careers_url}>
                          {source.careers_url.replace(/^https:\/\//, "")}
                        </a>
                      ) : (
                        <span className="mono">{source.token}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  )
}
