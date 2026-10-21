import { useCallback, useEffect, useMemo, useState } from "react"

import { api, UnauthorizedError } from "../api"
import { useAction, useApp } from "../app-context"
import { MultiSelect } from "../components/MultiSelect"
import { RunProgress, type RunState } from "../components/RunProgress"
import { SortHeader } from "../components/SortHeader"
import { Count, Empty, ScoreBadge, Skeletons, plural } from "../components/common"
import { getLang, useT } from "../i18n"
import type { ExploreBoard, ExploreCompany } from "../types"

const STORAGE_KEY = "jobradar.explore.providers"

type SortKey = "company" | "jobs" | "score"

const DEFAULT_DIR: Record<SortKey, "asc" | "desc"> = {
  company: "asc",
  jobs: "desc",
  score: "desc",
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

function boardLabel(boards: ExploreBoard[] | null, provider: string): string {
  return boards?.find((item) => item.provider === provider)?.label ?? provider
}

function readStored(): string[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []
  } catch {
    return []
  }
}

export function Explore({ onOpenJobs }: { onOpenJobs: (company: { company_key: string }) => void }) {
  const t = useT()
  const run = useAction()
  const { notify, logout, refresh, touchSources, cycleRunning } = useApp()
  const [boards, setBoards] = useState<ExploreBoard[] | null>(null)
  const [selected, setSelected] = useState<string[]>(readStored)
  const [refreshBoards, setRefreshBoards] = useState(false)
  const [scan, setScan] = useState<RunState | null>(null)
  const [companies, setCompanies] = useState<ExploreCompany[] | null | undefined>(undefined)
  const [busy, setBusy] = useState<string | null>(null)
  const [addingAll, setAddingAll] = useState<{ done: number; total: number } | null>(null)
  const [query, setQuery] = useState("")
  const [sort, setSort] = useState<SortKey>("jobs")
  const [dir, setDir] = useState<"asc" | "desc">("desc")
  const [launching, setLaunching] = useState(false)

  const loadBoards = useCallback(async () => {
    const result = await run(() => api.exploreBoards())
    if (!result) return
    setBoards(result.boards)
    setSelected((prev) => {
      const allowed = new Set(result.boards.map((board) => board.provider))
      const next = prev.filter((item) => allowed.has(item))
      return next.length === prev.length ? prev : next
    })
  }, [run])

  useEffect(() => {
    void loadBoards()
  }, [loadBoards])

  useEffect(() => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(selected))
  }, [selected])

  const options = useMemo(
    () =>
      (boards ?? []).map((board) => ({
        value: board.provider,
        label: board.label,
        hint: board.ready ? String(board.jobs) : t("needs a board URL"),
      })),
    [boards, t],
  )

  async function loadCompanies(providers: string[]) {
    const result = await run(() => api.explore(providers))
    if (result) setCompanies(result.companies)
  }

  async function launch() {
    if (selected.length === 0 || launching || cycleRunning) return
    const ready = selected.filter((provider) => boards?.find((board) => board.provider === provider)?.ready)
    const skipped = selected.length - ready.length
    if (ready.length === 0) {
      notify(t("Add Getro and Consider in Sources with a board link first"), "error")
      return
    }
    if (skipped) {
      notify(t("Getro/Consider without a URL were skipped — add the board in Sources"), "error")
    }

    setLaunching(true)
    setCompanies(null)
    try {
      const prepared = await api.explorePrepare(ready)
      const empty = ready.some((provider) => (boards?.find((board) => board.provider === provider)?.jobs ?? 0) === 0)
      const toRun = refreshBoards || prepared.created > 0 || empty ? prepared.sources : []

      if (toRun.length > 0) {
        let found = 0
        let fresh = 0
        let failed = 0
        setScan({
          phase: "sources",
          done: 0,
          total: toRun.length,
          current: "",
          currentId: null,
          found: 0,
          fresh: 0,
          failed: 0,
        })
        for (const [index, source] of toRun.entries()) {
          setScan((prev) => prev && { ...prev, done: index, current: source.label, currentId: source.id })
          try {
            const result = await api.runSource(source.id, { score: false })
            found += result.run.jobs_found
            fresh += result.run.jobs_new
            if (!result.run.ok) failed += 1
          } catch (error) {
            if (error instanceof UnauthorizedError) throw error
            failed += 1
          }
          touchSources()
          setScan((prev) => prev && { ...prev, done: index + 1, found, fresh, failed })
        }
      }
      await loadCompanies(ready)
      await loadBoards()
      refresh()
    } catch (error) {
      if (error instanceof UnauthorizedError) logout()
      else notify(error instanceof Error ? error.message : String(error), "error")
      setCompanies((prev) => prev ?? [])
    } finally {
      setScan(null)
      setLaunching(false)
      setCompanies((prev) => (prev === null ? [] : prev))
    }
  }

  async function track(company: ExploreCompany) {
    setBusy(company.company_key)
    const result = await run(() => api.addExplore(company.company_key))
    setBusy(null)
    if (!result) return
    notify(
      result.added
        ? t("{company} — tracking via {ats}", { company: company.company, ats: result.ats ?? "" })
        : t("{company}: ATS was not detected. Query sources will cover this company", { company: company.company }),
      result.added ? "ok" : "error",
    )
    if (result.added) {
      setCompanies((prev) => prev?.filter((item) => item.company_key !== company.company_key) ?? prev)
      refresh()
    }
  }

  async function trackAll(list: ExploreCompany[]) {
    if (list.length === 0 || addingAll || launching) return
    setAddingAll({ done: 0, total: list.length })
    let added = 0
    let skipped = 0
    try {
      for (const [index, company] of list.entries()) {
        setBusy(company.company_key)
        try {
          const result = await api.addExplore(company.company_key)
          if (result.added) {
            added += 1
            setCompanies((prev) => prev?.filter((item) => item.company_key !== company.company_key) ?? prev)
          } else {
            skipped += 1
          }
        } catch (error) {
          if (error instanceof UnauthorizedError) throw error
          skipped += 1
        }
        setAddingAll({ done: index + 1, total: list.length })
      }
      if (added) refresh()
      notify(
        skipped
          ? t("Added {added}, ATS was not detected for {skipped}", { added, skipped })
          : t("Added {added} {noun}", {
              added,
              noun: plural(added, countForms(t, "company", "a few companies", "companies")),
            }),
        added ? "ok" : "error",
      )
    } catch (error) {
      if (error instanceof UnauthorizedError) logout()
      else notify(error instanceof Error ? error.message : String(error), "error")
    } finally {
      setBusy(null)
      setAddingAll(null)
    }
  }

  function sortBy(column: SortKey) {
    if (sort === column) {
      setDir((prev) => (prev === "asc" ? "desc" : "asc"))
      return
    }
    setSort(column)
    setDir(DEFAULT_DIR[column])
  }

  const rows = useMemo(() => {
    if (!companies) return []
    const needle = query.trim().toLowerCase()
    const filtered = needle
      ? companies.filter((item) => item.company.toLowerCase().includes(needle))
      : companies
    const sign = dir === "asc" ? 1 : -1
    return [...filtered].sort((a, b) => {
      let left: string | number = 0
      let right: string | number = 0
      if (sort === "company") {
        left = a.company.toLowerCase()
        right = b.company.toLowerCase()
      } else if (sort === "jobs") {
        left = a.jobs
        right = b.jobs
      } else {
        left = a.best_score ?? -1
        right = b.best_score ?? -1
      }
      if (left < right) return -1 * sign
      if (left > right) return 1 * sign
      return a.company.localeCompare(b.company)
    })
  }, [companies, query, sort, dir])

  return (
    <>
      <p className="muted">
        {t(
          "Pick the boards and press \"Launch\". Himalayas, Remote OK, and the rest connect on their own. Getro and Consider are fund boards: add them with a link in Sources. Roles that are off profile are hidden from the normal job list — \"Jobs\" opens the full set for a company.",
        )}
      </p>

      <div className="filters">
        <MultiSelect label="ATS" options={options} selected={selected} onChange={setSelected} />
        <label className="check-inline">
          <input
            type="checkbox"
            className="checkbox"
            checked={refreshBoards}
            onChange={(event) => setRefreshBoards(event.target.checked)}
          />
          {t("Refresh boards first")}
        </label>
        <button
          className="btn btn-primary btn-sm"
          disabled={selected.length === 0 || launching || cycleRunning || boards === null}
          onClick={() => void launch()}
        >
          {launching ? t("Analyzing…") : t("Launch")}
        </button>
      </div>

      {scan ? <RunProgress state={scan} /> : null}

      {boards === null ? (
        <Skeletons />
      ) : companies === undefined ? (
        <Empty
          title={t("Pick an ATS and launch")}
          hint={t(
            "Himalayas, Arbeitnow, Remote OK, and the rest are already in the list. Getro and Consider show up as ready once you add a board URL in Sources.",
          )}
        />
      ) : companies === null ? (
        scan ? null : <Skeletons />
      ) : companies.length === 0 ? (
        <Empty
          title={t("Nothing to add")}
          hint={
            refreshBoards
              ? t("Either the boards are empty, or every company found is already in sources.")
              : t("Boards without jobs are crawled when you start. If the list is empty, turn on \"Refresh boards first\".")
          }
        />
      ) : (
        <>
          <div className="filters">
            <input
              className="input"
              placeholder={t("Search companies")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="row">
            <Count shown={rows.length} total={companies.length} forms={countForms(t, "company", "a few companies", "companies")}>
              {t(" · already in sources are hidden")}
              {addingAll ? t(" · adding {done} of {total}", { done: addingAll.done, total: addingAll.total }) : ""}
            </Count>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={Boolean(addingAll || launching || busy || rows.length === 0)}
              onClick={() => void trackAll(rows)}
            >
              {addingAll ? t("Adding…") : t("Add all")}
            </button>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <SortHeader column="company" label={t("Company")} sort={sort} dir={dir} onSort={sortBy} />
                  <SortHeader column="jobs" label={t("Jobs")} sort={sort} dir={dir} onSort={sortBy} className="col-score" />
                  <SortHeader column="score" label="Score" sort={sort} dir={dir} onSort={sortBy} className="col-score" />
                  <th>ATS</th>
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
                    <td className="col-score">{company.jobs}</td>
                    <td className="col-score">
                      <ScoreBadge score={company.best_score} />
                    </td>
                    <td>
                      <div className="row-tight" style={{ flexWrap: "wrap" }}>
                        {company.providers.split(",").map((provider) => (
                          <span key={provider} className="badge badge-neutral">
                            {boardLabel(boards, provider.trim())}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="col-actions">
                      <div className="row">
                        {company.jobs > 0 ? (
                          <button className="btn btn-sm" onClick={() => onOpenJobs(company)}>
                            {t("Jobs")}
                          </button>
                        ) : null}
                        <button
                          className="btn btn-primary btn-sm"
                          disabled={Boolean(busy || launching || addingAll)}
                          onClick={() => void track(company)}
                        >
                          {t("Add")}
                        </button>
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
