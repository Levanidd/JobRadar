import { useCallback, useMemo, useState } from "react"

import { api } from "../api"
import { useAction, useApp, useLoader } from "../app-context"
import { Age, Count, Empty, ScoreBadge, Skeletons } from "../components/common"
import { SortHeader } from "../components/SortHeader"
import { getLang, useT } from "../i18n"
import { oneOf, text, usePersistentState } from "../persist"
import type { DiscoveredCompany } from "../types"

type StateFilter = "" | "new" | "added" | "dismissed"
type JobsFilter = "" | "open" | "none"
/** "" any, "known"/"none" ask whether an ATS was detected, anything else names one. */
type AtsFilter = string
type SortKey = "company" | "jobs" | "score" | "seen" | "ats"

const STATE_LABELS: Record<DiscoveredCompany["state"], string> = {
  new: "New",
  added: "Monitoring",
  dismissed: "Hidden",
}

const STATE_BADGE: Record<DiscoveredCompany["state"], string> = {
  new: "badge-accent",
  added: "badge-positive",
  dismissed: "badge-neutral",
}

const DEFAULT_DIR: Record<SortKey, "asc" | "desc"> = {
  company: "asc",
  jobs: "desc",
  score: "desc",
  seen: "desc",
  ats: "asc",
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

function compare(a: DiscoveredCompany, b: DiscoveredCompany, sort: SortKey, dir: "asc" | "desc"): number {
  const sign = dir === "asc" ? 1 : -1
  let left: string | number = 0
  let right: string | number = 0
  if (sort === "company") {
    left = a.company.toLowerCase()
    right = b.company.toLowerCase()
  } else if (sort === "jobs") {
    left = a.jobs_open
    right = b.jobs_open
  } else if (sort === "score") {
    left = a.best_score ?? -1
    right = b.best_score ?? -1
  } else if (sort === "seen") {
    left = a.first_seen_at
    right = b.first_seen_at
  } else {
    left = (a.detected_ats ?? "").toLowerCase()
    right = (b.detected_ats ?? "").toLowerCase()
  }
  if (left < right) return -1 * sign
  if (left > right) return 1 * sign
  return a.company.localeCompare(b.company)
}

export function Discovery({ onOpenJobs }: { onOpenJobs: (company: DiscoveredCompany) => void }) {
  const t = useT()
  const run = useAction()
  const { notify } = useApp()
  const [companies, setCompanies] = useState<DiscoveredCompany[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [query, setQuery] = usePersistentState("discovery.query", "", text)
  const [state, setState] = usePersistentState<StateFilter>(
    "discovery.state",
    "new",
    oneOf("", "new", "added", "dismissed"),
  )
  // Options are built from the loaded companies, so they cannot be enumerated here.
  const [ats, setAts] = usePersistentState<AtsFilter>("discovery.ats", "", text)
  const [jobs, setJobs] = usePersistentState<JobsFilter>("discovery.jobs", "", oneOf("", "open", "none"))
  const [sort, setSort] = usePersistentState<SortKey>(
    "discovery.sort",
    "score",
    oneOf("company", "jobs", "score", "seen", "ats"),
  )
  const [dir, setDir] = usePersistentState<"asc" | "desc">("discovery.dir", "desc", oneOf("asc", "desc"))

  const load = useCallback(async (silent = false) => {
    if (!silent) setCompanies(null)
    const result = await run(() => api.discovered())
    if (result) setCompanies(result.companies)
  }, [run])

  useLoader(load)

  const providers = useMemo(() => {
    if (!companies) return []
    return [...new Set(companies.map((item) => item.detected_ats).filter((item): item is string => Boolean(item)))].sort()
  }, [companies])

  const rows = useMemo(() => {
    if (!companies) return []
    const needle = query.trim().toLowerCase()
    return companies
      .filter((item) => {
        if (state && item.state !== state) return false
        if (ats === "known" && !item.detected_ats) return false
        else if (ats === "none" && item.detected_ats) return false
        else if (ats && ats !== "known" && item.detected_ats !== ats) return false
        if (jobs === "open" && item.jobs_open <= 0) return false
        if (jobs === "none" && item.jobs_open > 0) return false
        if (!needle) return true
        const hay = `${item.company} ${item.detected_ats ?? ""} ${item.careers_url ?? ""}`.toLowerCase()
        return hay.includes(needle)
      })
      .sort((a, b) => compare(a, b, sort, dir))
  }, [companies, query, state, ats, jobs, sort, dir])

  function sortBy(column: SortKey) {
    if (sort === column) {
      setDir((prev) => (prev === "asc" ? "desc" : "asc"))
      return
    }
    setSort(column)
    setDir(DEFAULT_DIR[column])
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
    setCompanies(
      (prev) =>
        prev?.map((item) =>
          item.company_key === company.company_key
            ? { ...item, state: "added", detected_ats: result.ats ?? item.detected_ats }
            : item,
        ) ?? null,
    )
  }

  async function dismiss(company: DiscoveredCompany) {
    setBusy(company.company_key)
    const result = await run(() => api.dismissDiscovered(company.company_key))
    setBusy(null)
    if (!result) return
    setCompanies(
      (prev) =>
        prev?.map((item) => (item.company_key === company.company_key ? { ...item, state: "dismissed" } : item)) ?? null,
    )
  }

  return (
    <>
      <p className="muted">
        {t(
          "Companies from search boards that are not in sources yet. A card is here even when every role is off profile — those jobs stay out of the normal list. \"Jobs\" opens the full set, and \"Track\" connects the company board.",
        )}
      </p>

      <div className="filters">
        <input
          className="input"
          placeholder={t("Search companies")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select className="select" value={state} onChange={(event) => setState(event.target.value as StateFilter)}>
          <option value="">{t("All")}</option>
          <option value="new">{t("New")}</option>
          <option value="added">{t("Monitoring")}</option>
          <option value="dismissed">{t("Hidden")}</option>
        </select>
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
        <select className="select" value={jobs} onChange={(event) => setJobs(event.target.value as JobsFilter)}>
          <option value="">{t("All")}</option>
          <option value="open">{t("Has open jobs")}</option>
          <option value="none">{t("No open jobs")}</option>
        </select>
      </div>

      {companies === null ? (
        <Skeletons />
      ) : companies.length === 0 ? (
        <Empty
          title={t("Nothing here yet")}
          hint={t(
            "Companies show up here after a query-source run — they are collected from jobs that are not on the watchlist.",
          )}
        />
      ) : rows.length === 0 ? (
        <Empty title={t("Nothing found")} hint={t("Clear the filters or the search.")} />
      ) : (
        <>
          <Count
            shown={rows.length}
            total={companies.length}
            forms={countForms(t, "company", "a few companies", "companies")}
          />
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <SortHeader column="company" label={t("Company")} sort={sort} dir={dir} onSort={sortBy} />
                  <SortHeader column="jobs" label={t("Jobs")} sort={sort} dir={dir} onSort={sortBy} className="col-score" />
                  <SortHeader column="score" label="Score" sort={sort} dir={dir} onSort={sortBy} className="col-score" />
                  <SortHeader column="ats" label="ATS" sort={sort} dir={dir} onSort={sortBy} />
                  <th>{t("Status")}</th>
                  <SortHeader column="seen" label={t("Seen")} sort={sort} dir={dir} onSort={sortBy} className="col-date" />
                  <th className="col-actions" />
                </tr>
              </thead>
              <tbody>
                {rows.map((company) => (
                  <tr key={company.company_key} className={busy === company.company_key ? "is-busy" : ""}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{company.company}</div>
                      {company.sample_url ? (
                        <div className="cell-sub">
                          <a href={company.sample_url} target="_blank" rel="noreferrer">
                            {t("Job")} →
                          </a>
                        </div>
                      ) : null}
                    </td>
                    <td className="col-score">
                      {company.jobs_open > 0 ? (
                        <button
                          type="button"
                          className="cell-link cell-count"
                          title={t("Jobs at {company}", { company: company.company })}
                          onClick={() => onOpenJobs(company)}
                        >
                          {company.jobs_open}
                        </button>
                      ) : (
                        0
                      )}
                    </td>
                    <td className="col-score">
                      <ScoreBadge score={company.best_score} />
                    </td>
                    <td>
                      {company.detected_ats ? (
                        <span className="badge badge-accent">{company.detected_ats}</span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      <span className={`badge ${STATE_BADGE[company.state]}`}>{t(STATE_LABELS[company.state])}</span>
                    </td>
                    <td className="col-date">
                      <Age value={company.first_seen_at} warnAfter={14} />
                    </td>
                    <td className="col-actions">
                      <div className="row-tight">
                        {company.jobs_open > 0 ? (
                          <button className="btn btn-sm" onClick={() => onOpenJobs(company)}>
                            {t("Jobs")}
                          </button>
                        ) : null}
                        {company.state === "new" ? (
                          <>
                            <button
                              className="btn btn-primary btn-sm"
                              disabled={busy === company.company_key}
                              onClick={() => void track(company)}
                            >
                              {t("Track")}
                            </button>
                            <button
                              className="btn btn-ghost btn-sm"
                              disabled={busy === company.company_key}
                              onClick={() => void dismiss(company)}
                            >
                              {t("Hide")}
                            </button>
                          </>
                        ) : null}
                      </div>
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
