import { useCallback, useEffect, useMemo, useState } from "react"

import { api } from "../../../api"
import { useAction, useApp, useLoader } from "../../../app-context"
import { useT } from "../../../i18n"
import { oneOf, text, usePersistentState } from "../../../persist"
import type { DiscoveredCompany } from "../../../types"
import { Empty, Icon, Skeletons, scoreTone, shortDate } from "../../ui"
import {
  ChipGroup,
  JobsLink,
  PAGE,
  SearchBox,
  SortTh,
  TableCard,
  compareValues,
  nextSort,
  type Dir,
  type PaneProps,
} from "./shared"

type StateFilter = "new" | "added" | "dismissed" | "all"
/** "" any, "known"/"none" ask whether an ATS was detected, anything else names one. */
type AtsFilter = string
type SortKey = "company" | "seen" | "hits" | "jobs" | "score" | "ats"

const NATURAL: Record<SortKey, Dir> = { company: "asc", seen: "desc", hits: "desc", jobs: "desc", score: "desc", ats: "asc" }

function sortValue(company: DiscoveredCompany, sort: SortKey): string | number {
  switch (sort) {
    case "company":
      return company.company.toLowerCase()
    case "seen":
      return company.first_seen_at
    case "hits":
      return company.hits
    case "jobs":
      return company.jobs_open
    case "score":
      return company.best_score ?? -1
    case "ats":
      return (company.detected_ats ?? "~").toLowerCase()
  }
}

export function DiscoveryPane({ onCount, onScreen }: PaneProps) {
  const t = useT()
  const run = useAction()
  const { notify } = useApp()
  const [companies, setCompanies] = useState<DiscoveredCompany[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [limit, setLimit] = useState(PAGE)
  const [query, setQuery] = usePersistentState("v2.resources.discovery.query", "", text)
  const [state, setState] = usePersistentState<StateFilter>(
    "v2.resources.discovery.state",
    "new",
    oneOf("new", "added", "dismissed", "all"),
  )
  const [openOnly, setOpenOnly] = usePersistentState<boolean>("v2.resources.discovery.open", false, (raw) =>
    typeof raw === "boolean" ? raw : undefined,
  )
  // Options are built from the loaded companies, so they cannot be enumerated here.
  const [ats, setAts] = usePersistentState<AtsFilter>("v2.resources.discovery.ats", "", text)
  const [sort, setSort] = usePersistentState<SortKey>(
    "v2.resources.discovery.sort",
    "score",
    oneOf("company", "seen", "hits", "jobs", "score", "ats"),
  )
  const [dir, setDir] = usePersistentState<Dir>("v2.resources.discovery.dir", "desc", oneOf("asc", "desc"))

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setCompanies(null)
      const result = await run(() => api.discovered())
      if (result) setCompanies(result.companies)
    },
    [run],
  )

  useLoader(load)

  const counts = useMemo(() => {
    const list = companies ?? []
    return {
      new: list.filter((item) => item.state === "new").length,
      added: list.filter((item) => item.state === "added").length,
      dismissed: list.filter((item) => item.state === "dismissed").length,
      all: list.length,
    }
  }, [companies])

  useEffect(() => {
    onCount(companies ? counts.new : null)
  }, [companies, counts.new, onCount])

  useEffect(() => setLimit(PAGE), [query, state, openOnly, ats, sort, dir])

  const providers = useMemo(
    () => [...new Set((companies ?? []).map((item) => item.detected_ats).filter((item): item is string => Boolean(item)))].sort(),
    [companies],
  )

  const rows = useMemo(() => {
    if (!companies) return []
    const needle = query.trim().toLowerCase()
    return companies
      .filter((item) => {
        if (state !== "all" && item.state !== state) return false
        if (openOnly && item.jobs_open <= 0) return false
        if (ats === "known" && !item.detected_ats) return false
        if (ats === "none" && item.detected_ats) return false
        if (ats && ats !== "known" && ats !== "none" && item.detected_ats !== ats) return false
        if (!needle) return true
        return `${item.company} ${item.detected_ats ?? ""} ${item.careers_url ?? ""}`.toLowerCase().includes(needle)
      })
      .sort((a, b) => compareValues(sortValue(a, sort), sortValue(b, sort), dir) || a.company.localeCompare(b.company))
  }, [companies, query, state, openOnly, ats, sort, dir])

  function patch(key: string, change: Partial<DiscoveredCompany>) {
    setCompanies((prev) => prev?.map((item) => (item.company_key === key ? { ...item, ...change } : item)) ?? null)
  }

  async function track(company: DiscoveredCompany) {
    setBusy(company.company_key)
    const result = await run(() => api.addDiscovered(company.company_key))
    setBusy(null)
    if (!result) return
    notify(
      result.added
        ? t("{company} — tracking via {ats}", { company: company.company, ats: result.ats ?? "" })
        : t("{company}: ATS was not detected, the company stays on query sources", { company: company.company }),
      result.added ? "ok" : "error",
    )
    patch(company.company_key, { state: "added", detected_ats: result.ats ?? company.detected_ats })
  }

  async function dismiss(company: DiscoveredCompany) {
    setBusy(company.company_key)
    const result = await run(() => api.dismissDiscovered(company.company_key))
    setBusy(null)
    if (result) patch(company.company_key, { state: "dismissed" })
  }

  function sortBy(column: SortKey) {
    nextSort(column, sort, NATURAL, setSort, setDir)
  }

  const visible = rows.slice(0, limit)

  return (
    <div className="res-pane">
      <p className="muted res-intro">
        {t(
          "Companies met on aggregators and search queries. \"Track\" finds their ATS and connects it as a separate source, so the company's jobs come in directly.",
        )}
      </p>

      <div className="res-filters">
        <SearchBox value={query} onChange={setQuery} label={t("Search companies")} placeholder={t("Search companies")} />
        <ChipGroup
          label={t("Status")}
          value={state}
          onChange={setState}
          options={[
            { id: "new", label: t("New"), count: companies ? counts.new : null },
            { id: "added", label: t("Tracking"), count: companies ? counts.added : null },
            { id: "dismissed", label: t("Dismissed"), count: companies ? counts.dismissed : null },
            { id: "all", label: t("All"), count: companies ? counts.all : null },
          ]}
        />
        <label className="res-check">
          <input type="checkbox" checked={openOnly} onChange={(event) => setOpenOnly(event.target.checked)} />
          {t("Has open jobs")}
        </label>
        <label className="res-select">
          ATS
          <select className="select" value={ats} onChange={(event) => setAts(event.target.value)}>
            <option value="">{t("All")}</option>
            <option value="known">{t("ATS known")}</option>
            <option value="none">{t("ATS not found")}</option>
            {providers.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
      </div>

      {companies === null ? (
        <div className="res-skeletons">
          <Skeletons />
        </div>
      ) : companies.length === 0 ? (
        <div className="card">
          <Empty
            title={t("Nothing here yet")}
            hint={t(
              "Companies show up here after a query-source run — they are collected from jobs that are not on the watchlist.",
            )}
          />
        </div>
      ) : rows.length === 0 ? (
        <div className="card">
          <Empty title={t("Nothing found")} hint={t("Clear the filters or the search.")} />
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
          <table className="res-table res-table-discovery">
            <thead>
              <tr>
                <SortTh column="company" label={t("Company")} sort={sort} dir={dir} onSort={sortBy} className="res-first" />
                <SortTh column="seen" label={t("First seen")} sort={sort} dir={dir} onSort={sortBy} />
                <SortTh
                  column="hits"
                  label={t("Hits")}
                  title={t("How many times a crawl came across its jobs")}
                  sort={sort}
                  dir={dir}
                  onSort={sortBy}
                  align="right"
                />
                <SortTh column="jobs" label={t("Open now")} sort={sort} dir={dir} onSort={sortBy} align="right" />
                <SortTh column="score" label={t("Best score")} sort={sort} dir={dir} onSort={sortBy} />
                <SortTh column="ats" label="ATS" sort={sort} dir={dir} onSort={sortBy} />
                <th scope="col" className="res-last">
                  <span className="sr-only">{t("Actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((company) => (
                <tr key={company.company_key} className={busy === company.company_key ? "is-busy" : ""}>
                  <td className="res-first">
                    <div className="res-name">
                      <JobsLink onScreen={onScreen} className="res-strong-link" title={t("Open Jobs")}>
                        {company.company}
                      </JobsLink>
                      {company.sample_url ? (
                        <a className="res-sub-link" href={company.sample_url} target="_blank" rel="noreferrer">
                          {t("Sample job")} <Icon name="external" size={11} />
                        </a>
                      ) : null}
                    </div>
                  </td>
                  <td className="muted res-nowrap">{shortDate(company.first_seen_at)}</td>
                  <td className="res-num mono">{company.hits}</td>
                  <td className="res-num mono res-count">{company.jobs_open}</td>
                  <td>
                    <span className={`score score-${scoreTone(company.best_score)}`}>{company.best_score ?? "—"}</span>
                  </td>
                  <td>
                    {company.detected_ats ? (
                      <span className="chip chip-sky">{company.detected_ats}</span>
                    ) : (
                      <span className="chip chip-gray">{t("not found")}</span>
                    )}
                  </td>
                  <td className="res-last">
                    <div className="res-actions">
                      {company.state === "new" ? (
                        <>
                          <button
                            type="button"
                            className="btn btn-sm res-soft"
                            disabled={busy === company.company_key}
                            onClick={() => void track(company)}
                          >
                            {t("Track")}
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm res-quiet"
                            disabled={busy === company.company_key}
                            onClick={() => void dismiss(company)}
                          >
                            {t("Hide")}
                          </button>
                        </>
                      ) : company.state === "added" ? (
                        <span className="res-done">
                          <Icon name="check" size={14} />
                          {t("Tracking")}
                        </span>
                      ) : (
                        <span className="faint res-state">{t("Hidden")}</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableCard>
      )}
    </div>
  )
}
