import { useCallback, useEffect, useMemo, useState } from "react"

import { api, UnauthorizedError } from "../../../api"
import { useAction, useApp } from "../../../app-context"
import { useT } from "../../../i18n"
import type { ExploreBoard, ExploreCompany } from "../../../types"
import { Empty, Icon, Skeletons, scoreTone } from "../../ui"
import { hostOf } from "./links"
import {
  JobsLink,
  SearchBox,
  SortTh,
  compareValues,
  countWord,
  nextSort,
  type Dir,
  type PaneProps,
} from "./shared"

/** Same key as the current admin, so a pick carries over within the tab. */
const STORAGE_KEY = "jobradar.explore.providers"

type SortKey = "company" | "jobs" | "score"

const NATURAL: Record<SortKey, Dir> = { company: "asc", jobs: "desc", score: "desc" }

type Scan = { done: number; total: number; current: string; found: number; fresh: number; failed: number }

type Outcome = { added: true; ats: string | null } | { added: false }

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

function sortValue(company: ExploreCompany, sort: SortKey): string | number {
  if (sort === "company") return company.company.toLowerCase()
  if (sort === "jobs") return company.jobs
  return company.best_score ?? -1
}

export function ExplorePane({ onCount, onScreen, onSources }: PaneProps & { onSources: () => void }) {
  const t = useT()
  const run = useAction()
  const { notify, logout, refresh, touchSources, cycleRunning } = useApp()
  const [boards, setBoards] = useState<ExploreBoard[] | null>(null)
  const [selected, setSelected] = useState<string[]>(readStored)
  const [refreshBoards, setRefreshBoards] = useState(false)
  const [scan, setScan] = useState<Scan | null>(null)
  // undefined: not launched yet; null: loading.
  const [companies, setCompanies] = useState<ExploreCompany[] | null | undefined>(undefined)
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [addingAll, setAddingAll] = useState<{ done: number; total: number } | null>(null)
  const [query, setQuery] = useState("")
  const [sort, setSort] = useState<SortKey>("jobs")
  const [dir, setDir] = useState<Dir>("desc")
  const [launching, setLaunching] = useState(false)
  const [skippedNote, setSkippedNote] = useState(false)

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
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(selected))
    } catch {
      // The pick just does not outlive the page.
    }
  }, [selected])

  const pending = useMemo(
    () => (companies ?? []).filter((item) => !outcomes[item.company_key]?.added),
    [companies, outcomes],
  )

  useEffect(() => {
    onCount(companies ? pending.length : null)
  }, [companies, pending.length, onCount])

  const labels = useMemo(() => new Map((boards ?? []).map((board) => [board.provider, board.label])), [boards])
  const unready = (boards ?? []).filter((board) => !board.ready)

  function toggleBoard(provider: string, on: boolean) {
    setSelected((prev) => (on ? [...prev, provider] : prev.filter((item) => item !== provider)))
  }

  async function launch() {
    if (selected.length === 0 || launching || cycleRunning) return
    const ready = selected.filter((provider) => boards?.find((board) => board.provider === provider)?.ready)
    const skipped = selected.length - ready.length
    setSkippedNote(skipped > 0)
    if (ready.length === 0) {
      notify(t("Add Getro and Consider in Sources with a board link first"), "error")
      return
    }
    if (skipped) notify(t("Getro/Consider without a URL were skipped — add the board in Sources"), "error")

    setLaunching(true)
    setCompanies(null)
    setOutcomes({})
    try {
      const prepared = await api.explorePrepare(ready)
      const empty = ready.some((provider) => (boards?.find((board) => board.provider === provider)?.jobs ?? 0) === 0)
      const toRun = refreshBoards || prepared.created > 0 || empty ? prepared.sources : []

      if (toRun.length > 0) {
        let found = 0
        let fresh = 0
        let failed = 0
        setScan({ done: 0, total: toRun.length, current: "", found: 0, fresh: 0, failed: 0 })
        for (const [index, source] of toRun.entries()) {
          setScan((prev) => prev && { ...prev, done: index, current: source.label })
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
      const result = await run(() => api.explore(ready))
      if (result) setCompanies(result.companies)
      await loadBoards()
      refresh()
    } catch (error) {
      if (error instanceof UnauthorizedError) logout()
      else notify(error instanceof Error ? error.message : String(error), "error")
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
    setOutcomes((prev) => ({
      ...prev,
      [company.company_key]: result.added ? { added: true, ats: result.ats } : { added: false },
    }))
    if (result.added) {
      touchSources()
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
        let outcome: Outcome = { added: false }
        try {
          const result = await api.addExplore(company.company_key)
          outcome = result.added ? { added: true, ats: result.ats } : { added: false }
        } catch (error) {
          if (error instanceof UnauthorizedError) throw error
        }
        if (outcome.added) added += 1
        else skipped += 1
        setOutcomes((prev) => ({ ...prev, [company.company_key]: outcome }))
        setAddingAll({ done: index + 1, total: list.length })
      }
      if (added) {
        touchSources()
        refresh()
      }
      notify(
        skipped
          ? t("Added {added}, ATS was not detected for {skipped}", { added, skipped })
          : t("Added {added} {noun}", { added, noun: countWord(t, added, "company", "a few companies", "companies") }),
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
    nextSort(column, sort, NATURAL, setSort, setDir)
  }

  const rows = useMemo(() => {
    if (!companies) return []
    const needle = query.trim().toLowerCase()
    const filtered = needle ? companies.filter((item) => item.company.toLowerCase().includes(needle)) : companies
    return [...filtered].sort(
      (a, b) => compareValues(sortValue(a, sort), sortValue(b, sort), dir) || a.company.localeCompare(b.company),
    )
  }, [companies, query, sort, dir])

  // "Add all" covers what the list shows and has not been tried yet.
  const addable = rows.filter((item) => !outcomes[item.company_key])
  const percent = scan && scan.total > 0 ? Math.round((scan.done / scan.total) * 100) : 0

  return (
    <div className="res-pane">
      <section className="card res-step" aria-labelledby="res-ex1">
        <div className="res-step-head">
          <span className="mono faint">1</span>
          <h2 id="res-ex1">{t("Pick aggregator boards")}</h2>
          <span className="muted">{t("Empty boards are crawled at launch")}</span>
        </div>
        {boards === null ? (
          <div className="res-boards" aria-hidden="true">
            {Array.from({ length: 6 }, (_, index) => (
              <span key={index} className="skeleton res-board-skeleton" />
            ))}
          </div>
        ) : boards.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            {t("No boards are available.")}
          </p>
        ) : (
          <div className="res-boards" role="group" aria-label={t("Boards")}>
            {boards.map((board) => {
              const checked = selected.includes(board.provider)
              return (
                <label
                  key={board.provider}
                  className={`res-board${checked ? " is-on" : ""}${board.ready ? "" : " is-off"}`}
                  title={board.ready ? undefined : t("Add the board link in Sources first")}
                >
                  <input
                    type="checkbox"
                    checked={checked && board.ready}
                    disabled={!board.ready || launching}
                    onChange={(event) => toggleBoard(board.provider, event.target.checked)}
                  />
                  {board.label}
                  <span className="mono muted">{board.ready ? board.jobs : t("needs a link")}</span>
                </label>
              )
            })}
          </div>
        )}
        <div className="res-step-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={selected.length === 0 || launching || cycleRunning || boards === null}
            title={cycleRunning ? t("Wait for the current run to finish") : undefined}
            onClick={() => void launch()}
          >
            <Icon name="play" size={12} />
            {launching ? t("Analyzing…") : t("Launch")}
          </button>
          <label className="res-check">
            <input
              type="checkbox"
              checked={refreshBoards}
              disabled={launching}
              onChange={(event) => setRefreshBoards(event.target.checked)}
            />
            {t("Refresh boards first")}
          </label>
          {unready.length > 0 || skippedNote ? (
            <span className="muted res-note">
              {t("{boards} without a board link are skipped.", { boards: unready.map((board) => board.label).join(", ") || "Getro, Consider" })}{" "}
              <button type="button" className="btn-link" onClick={onSources}>
                {t("Add them in Sources")}
              </button>
            </span>
          ) : null}
        </div>
        {scan ? (
          <div className="res-scan" aria-live="polite">
            <div className="res-scan-head">
              <strong>{t("Crawling boards")}</strong>
              <span className="muted">
                {t("{done} of {total}", { done: scan.done, total: scan.total })}
                {scan.current ? ` · ${scan.current}` : ""}
              </span>
              <span className="chip chip-violet">{percent}%</span>
            </div>
            <div className="res-bar" role="progressbar" aria-valuemin={0} aria-valuemax={scan.total} aria-valuenow={scan.done}>
              <span style={{ width: `${percent}%` }} />
            </div>
            <span className="muted res-scan-foot">
              {t("Jobs {found}, {fresh} of them new", { found: scan.found, fresh: scan.fresh })}
              {scan.failed > 0 ? t(" · sources with errors: {failed}", { failed: scan.failed }) : ""}
            </span>
          </div>
        ) : null}
      </section>

      <section className="card res-step res-step-table" aria-labelledby="res-ex2">
        <div className="res-step-head res-step-head-pad">
          <span className="mono faint">2</span>
          <h2 id="res-ex2">{t("Companies from these boards")}</h2>
          {companies ? (
            <span className="muted">
              {pending.length} {countWord(t, pending.length, "company", "a few companies", "companies")}
              {t(" · already in sources are hidden")}
              {addingAll ? t(" · adding {done} of {total}", { done: addingAll.done, total: addingAll.total }) : ""}
            </span>
          ) : null}
          {companies && companies.length > 0 ? (
            <button
              type="button"
              className="btn btn-sm res-push"
              disabled={Boolean(addingAll || launching || busy || addable.length === 0)}
              onClick={() => void trackAll(addable)}
            >
              {addingAll ? t("Adding…") : t("Add all")}
            </button>
          ) : null}
        </div>

        {boards === null || companies === null ? (
          scan ? null : (
            <div className="res-step-body">
              <Skeletons count={4} />
            </div>
          )
        ) : companies === undefined ? (
          <Empty
            title={t("Pick boards and launch")}
            hint={t(
              "Himalayas, Arbeitnow, Remote OK, and the rest are already in the list. Getro and Consider show up as ready once you add a board URL in Sources.",
            )}
          />
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
            <div className="res-step-body">
              <SearchBox value={query} onChange={setQuery} label={t("Search companies")} placeholder={t("Search companies")} />
            </div>
            {rows.length === 0 ? (
              <Empty title={t("Nothing found")} hint={t("Clear the filters or the search.")} />
            ) : (
              <div className="res-scroll">
                <table className="res-table res-table-explore">
                  <thead>
                    <tr>
                      <SortTh column="company" label={t("Company")} sort={sort} dir={dir} onSort={sortBy} className="res-first" />
                      <th scope="col">{t("Sample job")}</th>
                      <th scope="col">{t("Boards")}</th>
                      <SortTh column="jobs" label={t("Jobs")} sort={sort} dir={dir} onSort={sortBy} align="right" />
                      <SortTh column="score" label="Score" sort={sort} dir={dir} onSort={sortBy} />
                      <th scope="col" className="res-last">
                        <span className="sr-only">{t("Actions")}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((company) => {
                      const outcome = outcomes[company.company_key]
                      const working = busy === company.company_key
                      return (
                        <tr key={company.company_key} className={working ? "is-busy" : ""}>
                          <td className="res-first">
                            <JobsLink onScreen={onScreen} className="res-strong-link" title={t("Open Jobs")}>
                              {company.company}
                            </JobsLink>
                          </td>
                          <td>
                            {company.sample_url ? (
                              <a className="res-sample" href={company.sample_url} target="_blank" rel="noreferrer">
                                {hostOf(company.sample_url)} <Icon name="external" size={11} />
                              </a>
                            ) : (
                              <span className="faint">—</span>
                            )}
                          </td>
                          <td className="muted">
                            {company.providers
                              .split(",")
                              .map((provider) => labels.get(provider.trim()) ?? provider.trim())
                              .join(", ")}
                          </td>
                          <td className="res-num mono res-count">{company.jobs}</td>
                          <td>
                            <span className={`score score-${scoreTone(company.best_score)}`}>{company.best_score ?? "—"}</span>
                          </td>
                          <td className="res-last">
                            <div className="res-actions">
                              {working ? (
                                <span className="muted res-state">{t("checking…")}</span>
                              ) : outcome?.added ? (
                                <span className="res-done">
                                  <Icon name="check" size={14} />
                                  {outcome.ats ? t("added · {ats}", { ats: outcome.ats }) : t("added")}
                                </span>
                              ) : outcome ? (
                                <span className="muted res-state">{t("ATS not found")}</span>
                              ) : (
                                <button
                                  type="button"
                                  className="btn btn-sm res-soft"
                                  disabled={Boolean(busy || launching || addingAll)}
                                  onClick={() => void track(company)}
                                >
                                  {t("Add")}
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  )
}
