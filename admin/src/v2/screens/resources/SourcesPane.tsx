import { useCallback, useEffect, useMemo, useState } from "react"

import { api } from "../../../api"
import { useAction, useApp, useLoader } from "../../../app-context"
import { useT } from "../../../i18n"
import { oneOf, text, usePersistentState } from "../../../persist"
import type { RunResult, Source, Tier } from "../../../types"
import { Empty, Icon, Skeletons, shortDate } from "../../ui"
import { labelFor, parseBulkUrls } from "./links"
import {
  ChipGroup,
  JobsLink,
  PAGE,
  SearchBox,
  SortTh,
  TableCard,
  compareValues,
  nextSort,
  whenLabel,
  type Dir,
  type PaneProps,
} from "./shared"

type StatusFilter = "" | "on" | "off" | "error" | "never"
type KindFilter = "" | "company" | "query"
type TierFilter = "" | Tier
type SortKey = "label" | "kind" | "jobs" | "run" | "added"

const NATURAL: Record<SortKey, Dir> = { label: "asc", kind: "asc", jobs: "desc", run: "desc", added: "desc" }

function runStatus(source: Source): "ok" | "error" | "never" {
  if (source.last_ok == null) return "never"
  return Number(source.last_ok) ? "ok" : "error"
}

function sortValue(source: Source, sort: SortKey): string | number {
  switch (sort) {
    case "label":
      return source.label.toLowerCase()
    case "kind":
      return `${source.kind}:${source.tier}`
    case "jobs":
      return source.active_jobs
    case "run":
      return source.last_run_at ?? ""
    case "added":
      return source.created_at ?? ""
  }
}

type BulkResult = { added: number; total: number; leftover: number }

export function SourcesPane({ onCount, onScreen }: PaneProps) {
  const t = useT()
  const run = useAction()
  const { notify, sourcesTick, runningSourceId } = useApp()
  const [sources, setSources] = useState<Source[] | null>(null)
  const [bulk, setBulk] = useState("")
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number; current: string } | null>(null)
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null)
  const [editing, setEditing] = useState<number | null>(null)
  const [draft, setDraft] = useState("")
  const [runningOne, setRunningOne] = useState<number | null>(null)
  const [lastRuns, setLastRuns] = useState<Record<number, RunResult>>({})
  const [limit, setLimit] = useState(PAGE)
  const [query, setQuery] = usePersistentState("v2.resources.sources.query", "", text)
  const [status, setStatus] = usePersistentState<StatusFilter>(
    "v2.resources.sources.status",
    "",
    oneOf("", "on", "off", "error", "never"),
  )
  const [kind, setKind] = usePersistentState<KindFilter>("v2.resources.sources.kind", "", oneOf("", "company", "query"))
  const [tier, setTier] = usePersistentState<TierFilter>("v2.resources.sources.tier", "", oneOf("", "watchlist", "discovery"))
  // Providers come from the loaded sources, so they cannot be enumerated here.
  const [provider, setProvider] = usePersistentState("v2.resources.sources.provider", "", text)
  const [sort, setSort] = usePersistentState<SortKey>(
    "v2.resources.sources.sort",
    "added",
    oneOf("label", "kind", "jobs", "run", "added"),
  )
  const [dir, setDir] = usePersistentState<Dir>("v2.resources.sources.dir", "desc", oneOf("asc", "desc"))

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setSources(null)
      const result = await run(() => api.sources())
      if (result) setSources(result.sources)
    },
    [run],
  )

  // Follows the running cycle too, so jobs and last runs catch up board by board.
  useLoader(load, sourcesTick)

  useEffect(() => {
    onCount(sources ? sources.length : null)
  }, [sources, onCount])

  useEffect(() => setLimit(PAGE), [query, status, kind, tier, provider, sort, dir])

  const providers = useMemo(() => [...new Set((sources ?? []).map((item) => item.provider))].sort(), [sources])

  const counts = useMemo(() => {
    const list = sources ?? []
    return {
      all: list.length,
      on: list.filter((item) => item.enabled).length,
      off: list.filter((item) => !item.enabled).length,
      error: list.filter((item) => runStatus(item) === "error").length,
      never: list.filter((item) => runStatus(item) === "never").length,
    }
  }, [sources])

  const rows = useMemo(() => {
    if (!sources) return []
    const needle = query.trim().toLowerCase()
    return sources
      .filter((item) => {
        if (status === "on" && !item.enabled) return false
        if (status === "off" && item.enabled) return false
        if ((status === "error" || status === "never") && runStatus(item) !== status) return false
        if (kind && item.kind !== kind) return false
        if (tier && item.tier !== tier) return false
        if (provider && item.provider !== provider) return false
        if (!needle) return true
        return `${item.label} ${item.provider} ${item.token} ${item.careers_url ?? ""}`.toLowerCase().includes(needle)
      })
      .sort((a, b) => compareValues(sortValue(a, sort), sortValue(b, sort), dir) || b.id - a.id)
  }, [sources, query, status, kind, tier, provider, sort, dir])

  function patch(id: number, change: Partial<Source>) {
    setSources((prev) => prev?.map((item) => (item.id === id ? { ...item, ...change } : item)) ?? null)
  }

  async function addLinks() {
    const parsed = parseBulkUrls(bulk)
    if (parsed.urls.length === 0 && parsed.leftover.length === 0) return
    setBulkBusy(true)
    setBulkResult(null)
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
        const { ats, token } = detected
        const created = await run(() =>
          api.createSource({
            kind: "company",
            tier: "watchlist",
            label: labelFor(href, token),
            provider: ats,
            token,
            careers_url: href,
          }),
        )
        if (created) added += 1
        else failed.push(href)
      }
      // Whatever was not recognised stays in the field, to fix and try again.
      setBulk(failed.join("\n"))
      const total = parsed.urls.length + parsed.leftover.length
      setBulkResult({ added, total, leftover: failed.length })
      notify(
        failed.length === 0
          ? t("Added {added}", { added })
          : t("Added {added} of {total}. Unrecognized links stayed in the field", { added, total }),
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
    patch(source.id, { enabled: next })
    const result = await run(() => api.updateSource(source.id, { enabled: next }))
    if (!result) patch(source.id, { enabled: source.enabled })
  }

  async function rename(source: Source) {
    const label = draft.trim()
    setEditing(null)
    if (!label || label === source.label) return
    const result = await run(() => api.updateSource(source.id, { label }))
    if (result) patch(source.id, { label })
  }

  async function changeTier(source: Source, next: Tier) {
    const result = await run(() => api.updateSource(source.id, { tier: next }))
    if (result) patch(source.id, { tier: next })
  }

  async function runOne(source: Source) {
    setRunningOne(source.id)
    const result = await run(() => api.runSource(source.id))
    setRunningOne(null)
    if (!result) return
    setLastRuns((prev) => ({ ...prev, [source.id]: result.run }))
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
    if (!window.confirm(t('Delete "{label}"? Application history is kept.', { label: source.label }))) return
    const result = await run(() => api.deleteSource(source.id), t("{label} deleted", { label: source.label }))
    if (result) setSources((prev) => prev?.filter((item) => item.id !== source.id) ?? null)
  }

  function sortBy(column: SortKey) {
    nextSort(column, sort, NATURAL, setSort, setDir)
  }

  function lastRun(source: Source) {
    const busy = runningOne === source.id || runningSourceId === source.id
    const state = runStatus(source)
    const fresh = lastRuns[source.id]
    const tone = busy ? "violet" : state === "ok" ? "green" : state === "error" ? "red" : "gray"
    const head = busy
      ? t("Running…")
      : state === "never"
        ? t("not run yet")
        : state === "error"
          ? (source.last_error ?? t("error"))
          : fresh?.ok
            ? t("found {found}, {fresh} new", { found: fresh.jobs_found, fresh: fresh.jobs_new })
            : t("found {found}", { found: source.last_count ?? source.active_jobs })
    const sub = state === "never" ? t("added on {date}", { date: shortDate(source.created_at) }) : whenLabel(t, source.last_run_at)
    return (
      <div className="res-run">
        <span className={`res-dot res-dot-${tone}${busy ? " is-busy" : ""}`} aria-hidden="true" />
        <div className="res-run-text">
          <span className={state === "error" && !busy ? "res-run-error" : ""} title={state === "error" ? (source.last_error ?? undefined) : undefined}>
            {head}
          </span>
          {sub ? <span className="res-sub">{sub}</span> : null}
        </div>
      </div>
    )
  }

  // No counts until the list is in, rather than a row of zeros.
  const shown = (count: number) => (sources ? count : null)
  const statusOptions: Array<{ id: StatusFilter; label: string; count: number | null }> = [
    { id: "", label: t("All"), count: shown(counts.all) },
    { id: "on", label: t("Enabled"), count: shown(counts.on) },
    { id: "off", label: t("Disabled"), count: shown(counts.off) },
    { id: "error", label: t("With errors"), count: shown(counts.error) },
  ]
  if (counts.never > 0 || status === "never") statusOptions.push({ id: "never", label: t("Never run"), count: shown(counts.never) })

  const visible = rows.slice(0, limit)

  return (
    <div className="res-pane">
      <section className="card res-add" aria-labelledby="res-add-title">
        <div className="res-add-intro">
          <h2 id="res-add-title">{t("Add a company")}</h2>
          <p className="muted">
            {t("Career-page links, one per line. The ATS is detected on its own, and whatever is not recognised stays in the field.")}
          </p>
        </div>
        <div className="res-add-form">
          <label htmlFor="res-add-urls" className="res-label">
            {t("Links")}
          </label>
          <textarea
            id="res-add-urls"
            className="textarea mono res-urls"
            rows={3}
            placeholder={"https://boards.greenhouse.io/company\nhttps://jobs.lever.co/company"}
            value={bulk}
            disabled={bulkBusy}
            onChange={(event) => setBulk(event.target.value)}
          />
          <div className="res-add-actions">
            <button type="button" className="btn btn-primary" disabled={bulkBusy || !bulk.trim()} onClick={() => void addLinks()}>
              {bulkBusy ? t("Checking…") : t("Add")}
            </button>
            {bulkProgress ? (
              <span className="muted res-progress-text" aria-live="polite">
                {t("{done} of {total}", { done: bulkProgress.done + 1, total: bulkProgress.total })} · {bulkProgress.current}
              </span>
            ) : bulkResult ? (
              <span className={`chip ${bulkResult.leftover ? "chip-amber" : "chip-green"} res-result`} role="status">
                {bulkResult.leftover
                  ? t("Added {added} of {total} · unrecognised links stayed in the field", {
                      added: bulkResult.added,
                      total: bulkResult.total,
                    })
                  : t("Added {added}", { added: bulkResult.added })}
              </span>
            ) : null}
          </div>
        </div>
      </section>

      <div className="res-filters">
        <SearchBox
          value={query}
          onChange={setQuery}
          label={t("Search sources")}
          placeholder={t("Search by name or token")}
        />
        <ChipGroup label={t("Status")} value={status} options={statusOptions} onChange={setStatus} />
        <label className="res-select">
          {t("Type")}
          <select className="select" value={kind} onChange={(event) => setKind(event.target.value as KindFilter)}>
            <option value="">{t("All")}</option>
            <option value="company">{t("Company")}</option>
            <option value="query">{t("Query")}</option>
          </select>
        </label>
        <label className="res-select">
          Tier
          <select className="select" value={tier} onChange={(event) => setTier(event.target.value as TierFilter)}>
            <option value="">{t("All")}</option>
            <option value="watchlist">Watchlist</option>
            <option value="discovery">Discovery</option>
          </select>
        </label>
        {providers.length > 1 ? (
          <label className="res-select">
            ATS
            <select className="select" value={provider} onChange={(event) => setProvider(event.target.value)}>
              <option value="">{t("All")}</option>
              {providers.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      {sources === null ? (
        <div className="res-skeletons">
          <Skeletons />
        </div>
      ) : sources.length === 0 ? (
        <div className="card">
          <Empty title={t("No sources")} hint={t("Add a company by its career-page link above.")} />
        </div>
      ) : rows.length === 0 ? (
        <div className="card">
          <Empty title={t("Nothing found")} hint={t("Clear the filters.")} />
        </div>
      ) : (
        <TableCard
          footer={
            rows.length > limit ? (
              <button type="button" className="btn btn-sm" onClick={() => setLimit((prev) => prev + PAGE * 4)}>
                {t("Show {count} more", { count: rows.length - limit })}
              </button>
            ) : null
          }
        >
          <table className="res-table res-table-sources">
            <thead>
              <tr>
                <SortTh column="label" label={t("Source")} sort={sort} dir={dir} onSort={sortBy} className="res-first" />
                <SortTh column="kind" label={t("Type")} sort={sort} dir={dir} onSort={sortBy} />
                <SortTh column="jobs" label={t("Jobs")} sort={sort} dir={dir} onSort={sortBy} align="right" />
                <SortTh column="run" label={t("Last run")} sort={sort} dir={dir} onSort={sortBy} />
                <th scope="col">{t("On")}</th>
                <th scope="col" className="res-last">
                  <span className="sr-only">{t("Actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((source) => {
                const busy = runningOne === source.id || runningSourceId === source.id
                return (
                  <tr key={source.id} className={`${source.enabled ? "" : "is-off"}${busy ? " is-busy" : ""}`}>
                    <td className="res-first">
                      <div className="res-name">
                        {editing === source.id ? (
                          <input
                            className="input res-rename"
                            aria-label={t("Name")}
                            value={draft}
                            autoFocus
                            onChange={(event) => setDraft(event.target.value)}
                            onBlur={() => void rename(source)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") void rename(source)
                              if (event.key === "Escape") setEditing(null)
                            }}
                          />
                        ) : (
                          <JobsLink onScreen={onScreen} className="res-strong-link" title={t("Open Jobs")}>
                            {source.label}
                          </JobsLink>
                        )}
                        <span className="mono res-sub">
                          {source.provider} · {source.token}
                          {source.careers_url ? (
                            <>
                              {" "}
                              <a
                                href={source.careers_url}
                                target="_blank"
                                rel="noreferrer"
                                className="res-ext"
                                title={source.careers_url}
                                aria-label={t("Careers page of {label}", { label: source.label })}
                              >
                                <Icon name="external" size={12} />
                              </a>
                            </>
                          ) : null}
                        </span>
                      </div>
                    </td>
                    <td>
                      <div className="res-type">
                        <span className={`chip ${source.kind === "query" ? "chip-sky" : "chip-violet"}`}>
                          {source.kind === "query" ? t("Query") : t("Company")}
                        </span>
                        <select
                          className="res-tier"
                          aria-label={t("Tier of {label}", { label: source.label })}
                          value={source.tier}
                          onChange={(event) => void changeTier(source, event.target.value as Tier)}
                        >
                          <option value="watchlist">Watchlist</option>
                          <option value="discovery">Discovery</option>
                        </select>
                      </div>
                    </td>
                    <td className="res-num mono res-count">{source.active_jobs}</td>
                    <td>{lastRun(source)}</td>
                    <td>
                      <button
                        type="button"
                        role="switch"
                        className="res-switch"
                        aria-checked={Boolean(source.enabled)}
                        aria-label={t("Source {label} enabled", { label: source.label })}
                        onClick={() => void toggle(source)}
                      >
                        <span />
                      </button>
                    </td>
                    <td className="res-last">
                      <div className="res-actions">
                        <button
                          type="button"
                          className="btn btn-sm"
                          title={t("Crawl only this board, without a full run")}
                          disabled={busy}
                          onClick={() => void runOne(source)}
                        >
                          <Icon name="play" size={11} />
                          {busy ? t("Running…") : t("Run")}
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label={t("Rename {label}", { label: source.label })}
                          title={t("Rename")}
                          onClick={() => {
                            setEditing(source.id)
                            setDraft(source.label)
                          }}
                        >
                          <Icon name="pencil" size={15} />
                        </button>
                        <button
                          type="button"
                          className="icon-btn res-danger"
                          aria-label={t("Delete {label}", { label: source.label })}
                          title={t("Delete")}
                          onClick={() => void remove(source)}
                        >
                          <Icon name="trash" size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </TableCard>
      )}
    </div>
  )
}
