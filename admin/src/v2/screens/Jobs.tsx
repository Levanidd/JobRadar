import { useCallback, useEffect, useRef, useState } from "react"

import { api, type JobFilters, type JobSort } from "../../api"
import { useAction, useApp, useLoader } from "../../app-context"
import { formatSalary } from "../../components/common"
import { useT } from "../../i18n"
import { usePersistentState } from "../../persist"
import type { Job, JobStatus } from "../../types"
import { JobPanel, inPipeline } from "../JobPanel"
import { Empty, Icon, Score, Skeletons, ago, flagLabels, repostLabel } from "../ui"

/** Each tab is a preset of filters the API already has. */
type Tab = "new" | "later" | "viewed" | "all" | "hidden"

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "new", label: "New" },
  { id: "later", label: "Later" },
  { id: "viewed", label: "Viewed" },
  { id: "all", label: "All" },
  { id: "hidden", label: "Hidden jobs" },
]

type Prefs = {
  tab: Tab
  min_score: number
  added_days?: number
  tier?: string
  /** "" keeps prefiltered postings out, as the current list does by default; "any" brings them back. */
  scope: "" | "any"
  sort: JobSort
}

const DEFAULT_PREFS: Prefs = { tab: "new", min_score: 50, scope: "", sort: "score" }

const SORTS: JobSort[] = ["score", "added", "posted", "updated"]

function revivePrefs(raw: unknown): Prefs | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const stored = raw as Record<string, unknown>
  const tab = TABS.some((item) => item.id === stored.tab) ? (stored.tab as Tab) : "new"
  return {
    tab,
    min_score: typeof stored.min_score === "number" ? stored.min_score : 50,
    added_days: typeof stored.added_days === "number" ? stored.added_days : undefined,
    tier: typeof stored.tier === "string" && stored.tier ? stored.tier : undefined,
    scope: stored.scope === "any" ? "any" : "",
    sort: SORTS.includes(stored.sort as JobSort) ? (stored.sort as JobSort) : "score",
  }
}

function toFilters(prefs: Prefs, company: { key: string } | null): JobFilters {
  const marks: JobFilters =
    prefs.tab === "new"
      ? { applied: "no", later: "no", viewed: "no" }
      : prefs.tab === "later"
        ? { later: "yes" }
        : prefs.tab === "viewed"
          ? { viewed: "yes" }
          : {}
  return {
    ...marks,
    status: prefs.tab === "hidden" ? "ignored" : prefs.scope || undefined,
    min_score: company ? 0 : prefs.min_score,
    added_days: prefs.added_days,
    tier: prefs.tier,
    companies: company ? [company.key] : undefined,
    sort: prefs.sort,
    dir: "desc",
  }
}

/** Whether a job still belongs on the open tab after an edit. Viewing alone never moves it. */
function fitsTab(job: Job, tab: Tab): boolean {
  if (tab === "hidden") return job.status === "ignored"
  if (job.status === "ignored") return false
  if (tab === "new") return !job.later_at && !inPipeline(job)
  if (tab === "later") return Boolean(job.later_at)
  if (tab === "viewed") return Boolean(job.viewed_at)
  return true
}

const PAGE_SIZE = 50

export function Jobs() {
  const t = useT()
  const run = useAction()
  const { notify } = useApp()
  const [prefs, setPrefs] = usePersistentState<Prefs>("v2.jobs", DEFAULT_PREFS, revivePrefs)
  const [company, setCompany] = useState<{ key: string; name: string } | null>(null)
  const [jobs, setJobs] = useState<Job[] | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [nextOffset, setNextOffset] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<Job | null>(null)
  const [showDetail, setShowDetail] = useState(false)
  const [scoring, setScoring] = useState<string | null>(null)
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null)
  const generation = useRef(0)
  const previous = useRef(new Map<string, JobStatus>())

  const filters = toFilters(prefs, company)
  const filterKey = JSON.stringify(filters)

  const load = useCallback(
    async (silent = false) => {
      const gen = ++generation.current
      if (!silent) setJobs(null)
      const result = await run(() => api.jobs({ ...(JSON.parse(filterKey) as JobFilters), limit: PAGE_SIZE }))
      if (gen !== generation.current || !result) return
      const seen = new Set<string>()
      const list = result.jobs.filter((job) => (seen.has(job.id) ? false : (seen.add(job.id), true)))
      setJobs(list)
      setHasMore(result.has_more)
      setNextOffset(result.next_offset)
      setSelectedId((prev) => (prev && list.some((job) => job.id === prev) ? prev : (list[0]?.id ?? null)))
    },
    [run, filterKey],
  )

  useLoader(load)

  async function showMore() {
    if (loadingMore || !hasMore) return
    const gen = generation.current
    setLoadingMore(true)
    const result = await run(() => api.jobs({ ...filters, limit: PAGE_SIZE, offset: nextOffset }))
    setLoadingMore(false)
    if (!result || gen !== generation.current) return
    setJobs((prev) => {
      const seen = new Set((prev ?? []).map((job) => job.id))
      return [...(prev ?? []), ...result.jobs.filter((job) => !seen.has(job.id))]
    })
    setHasMore(result.has_more)
    setNextOffset(result.next_offset)
  }

  const selectedIndex = jobs?.findIndex((job) => job.id === selectedId) ?? -1
  const listed = selectedIndex >= 0 && jobs ? jobs[selectedIndex] : null
  const current = detail && detail.id === selectedId ? detail : listed

  // The list row lacks the description, stages and duplicates; the card fetches the full job.
  const requested = useRef<string | null>(null)
  const fetchDetail = useCallback(
    async (id: string) => {
      requested.current = id
      setDetail(null)
      const result = await run(() => api.job(id))
      if (result && requested.current === id) setDetail(result.job)
    },
    [run],
  )

  // Covers the job picked without a click: the first one after the list loads.
  useEffect(() => {
    if (selectedId && requested.current !== selectedId) void fetchDetail(selectedId)
  }, [selectedId, fetchDetail])

  const open = useCallback(
    async (job: Job, explicit: boolean) => {
      setSelectedId(job.id)
      if (explicit) setShowDetail(true)
      await fetchDetail(job.id)
      // Opening a card never marks it viewed: flipping through the list is not a decision,
      // and "viewed" drops the job out of New here and in the current admin.
    },
    [fetchDetail],
  )

  /** Applies an edit to the list and the card; `move` drops a row that no longer fits the tab. */
  function patch(id: string, next: Partial<Job>, move = true) {
    setJobs((prev) => {
      if (!prev) return prev
      const index = prev.findIndex((job) => job.id === id)
      const updated = prev.map((job) => (job.id === id ? { ...job, ...next } : job))
      const target = updated[index]
      if (!move || !target || fitsTab(target, prefs.tab)) return updated
      // The row leaves the tab, and the card moves on to the next one in line.
      const rest = updated.filter((job) => job.id !== id)
      const following = rest[index] ?? rest[index - 1] ?? null
      window.setTimeout(() => {
        if (following) void open(following, false)
        else setSelectedId(null)
      })
      return rest
    })
    setDetail((prev) => (prev && prev.id === id ? { ...prev, ...next } : prev))
  }

  async function setStatus(job: Job, status: JobStatus) {
    if (status === "applied" && !inPipeline(job)) previous.current.set(job.id, job.status)
    const target = status === "saved" ? (previous.current.get(job.id) ?? "saved") : status
    const result = await run(() => api.setJobStatus(job.id, target))
    if (!result) return
    patch(job.id, {
      status: result.status,
      applied_at: result.applied_at,
      viewed_at: result.viewed_at,
      later_at: result.later_at,
      interviewed_at: result.interviewed_at,
    })
  }

  async function toggleLater(job: Job) {
    const result = await run(() => api.setJobLater(job.id, !job.later_at))
    if (result) patch(job.id, { later_at: result.later_at })
  }

  async function toggleViewed(job: Job) {
    const result = await run(() => api.setJobViewed(job.id, !job.viewed_at))
    if (result) patch(job.id, { viewed_at: result.viewed_at })
  }

  async function rescore(job: Job) {
    setScoring(job.id)
    const result = await run(() => api.scoreJob(job.id))
    setScoring(null)
    if (!result) return
    notify(`Score ${result.score}`)
    patch(job.id, { score: result.score, score_reason: result.score_reason, flags: result.flags, status: result.status }, false)
  }

  async function rescoreAll() {
    if (!jobs?.length || batch) return
    const ids = jobs.map((job) => job.id)
    setBatch({ done: 0, total: ids.length })
    let done = 0
    try {
      for (let i = 0; i < ids.length; i += 10) {
        const result = await run(() => api.scoreJobs(ids.slice(i, i + 10)))
        if (!result) return
        const byId = new Map(result.jobs.map((item) => [item.id, item]))
        setJobs((prev) => prev?.map((job) => {
          const next = byId.get(job.id)
          return next ? { ...job, score: next.score, score_reason: next.score_reason, flags: next.flags, status: next.status } : job
        }) ?? null)
        done += result.jobs.length
        setBatch({ done, total: ids.length })
      }
      notify(t("Rescored {count} {noun}", { count: done, noun: t("jobs") }))
    } finally {
      setBatch(null)
    }
  }

  async function openById(id: string) {
    const result = await run(() => api.job(id))
    if (!result) return
    requested.current = result.job.id
    setSelectedId(result.job.id)
    setDetail(result.job)
    setShowDetail(true)
  }

  function update<K extends keyof Prefs>(key: K, value: Prefs[K]) {
    setPrefs((prev) => ({ ...prev, [key]: value }))
  }

  return (
    <div className={`split${showDetail && current ? " has-detail" : ""}`}>
      <section className="list-pane" aria-label={t("Jobs")}>
        <div className="list-head">
          <div className="list-title">
            <h1>{t("Jobs")}</h1>
            <button
              type="button"
              className="btn btn-sm"
              style={{ marginLeft: "auto" }}
              disabled={!jobs?.length || Boolean(batch)}
              title={t("Rescore all")}
              onClick={() => void rescoreAll()}
            >
              <Icon name="refresh" size={13} />
              {batch ? t("scoring {done} of {total}", batch) : t("Rescore")}
            </button>
          </div>
          <div className="seg seg-fill" role="tablist" aria-label={t("Jobs")}>
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={prefs.tab === tab.id}
                onClick={() => update("tab", tab.id)}
              >
                {t(tab.label)}
              </button>
            ))}
          </div>
          <div className="filters">
            {company ? (
              <span className="filter-chip">
                {company.name}
                <button type="button" aria-label={t("Clear the company filter")} onClick={() => setCompany(null)}>
                  ×
                </button>
              </span>
            ) : (
              <select
                className="select"
                aria-label="Score"
                value={prefs.min_score}
                onChange={(event) => update("min_score", Number(event.target.value))}
              >
                <option value={0}>Score: {t("All")}</option>
                {[40, 50, 70, 85].map((score) => (
                  <option key={score} value={score}>
                    Score ≥ {score}
                  </option>
                ))}
              </select>
            )}
            <select
              className="select"
              aria-label={t("Added")}
              value={prefs.added_days ?? ""}
              onChange={(event) => update("added_days", event.target.value ? Number(event.target.value) : undefined)}
            >
              <option value="">{t("Any time")}</option>
              <option value="1">{t("Today")}</option>
              <option value="3">{t("Last 3 days")}</option>
              <option value="7">{t("Last week")}</option>
              <option value="30">{t("Last month")}</option>
            </select>
            <select
              className="select"
              aria-label={t("Boards")}
              value={prefs.tier ?? ""}
              onChange={(event) => update("tier", event.target.value || undefined)}
            >
              <option value="">{t("All boards")}</option>
              <option value="watchlist">Watchlist</option>
              <option value="discovery">Discovery</option>
            </select>
            {prefs.tab !== "hidden" ? (
              <select
                className="select"
                aria-label={t("Status")}
                value={prefs.scope}
                onChange={(event) => update("scope", event.target.value === "any" ? "any" : "")}
              >
                <option value="">{t("On profile")}</option>
                <option value="any">{t("Including filtered out")}</option>
              </select>
            ) : null}
            <select
              className="select"
              aria-label={t("Sort")}
              value={prefs.sort}
              onChange={(event) => update("sort", event.target.value as JobSort)}
            >
              <option value="score">↓ Score</option>
              <option value="added">↓ {t("Added")}</option>
              <option value="posted">↓ {t("Posted")}</option>
              <option value="updated">↓ {t("Updated")}</option>
            </select>
          </div>
        </div>

        <div className="list-body">
          {jobs === null ? (
            <Skeletons />
          ) : jobs.length === 0 ? (
            <Empty title={t("Nothing found")} hint={t("Loosen the filters or start a run.")} />
          ) : (
            <>
              {jobs.map((job) => {
                const pay = formatSalary(job.salary_min, job.salary_max, job.salary_currency)
                const flags = flagLabels(job.flags)
                const repost = repostLabel(job.flags)
                return (
                  <button
                    key={job.id}
                    type="button"
                    className="row"
                    aria-current={job.id === selectedId}
                    onClick={() => void open(job, true)}
                  >
                    <Score job={job} />
                    <span className="row-main">
                      <span className="row-title">{job.title}</span>
                      <span className="row-sub">{[job.company, job.location, pay].filter(Boolean).join(" · ")}</span>
                      {flags.length || repost || job.later_at ? (
                        <span className="row-badges">
                          {job.later_at && prefs.tab !== "later" ? <span className="chip chip-sky">{t("Later")}</span> : null}
                          {flags.map((flag) => (
                            <span key={flag} className="chip chip-red">
                              {flag}
                            </span>
                          ))}
                          {repost ? <span className="chip chip-amber">{repost.label}</span> : null}
                        </span>
                      ) : null}
                    </span>
                    <span className="row-side">{ago(job.first_seen_at)}</span>
                  </button>
                )
              })}
              {hasMore ? (
                <button type="button" className="btn btn-sm" style={{ margin: "8px auto" }} disabled={loadingMore} onClick={() => void showMore()}>
                  {loadingMore ? t("Loading…") : t("Show more")}
                </button>
              ) : null}
            </>
          )}
        </div>
        {jobs?.length ? (
          <div className="list-foot">
            {t("{count} in the list", { count: `${jobs.length}${hasMore ? "+" : ""}` })}
          </div>
        ) : null}
      </section>

      <section className="detail-pane" aria-label={t("Job card")}>
        {current ? (
          <JobPanel
            job={current}
            scoring={scoring === current.id}
            position={jobs && selectedIndex >= 0 ? `${selectedIndex + 1} / ${jobs.length}${hasMore ? "+" : ""}` : undefined}
            onPrev={jobs && selectedIndex > 0 ? () => void open(jobs[selectedIndex - 1], true) : undefined}
            onNext={jobs && selectedIndex >= 0 && selectedIndex < jobs.length - 1 ? () => void open(jobs[selectedIndex + 1], true) : undefined}
            onBack={() => setShowDetail(false)}
            handlers={{
              onPatch: (next) => patch(current.id, next, false),
              onStatus: (status) => void setStatus(current, status),
              onToggleLater: () => void toggleLater(current),
              onToggleViewed: () => void toggleViewed(current),
              onRescore: () => void rescore(current),
              onOpenCompany: (job) => {
                setCompany({ key: job.company_key, name: job.company })
                update("tab", "all")
              },
              onOpenJob: (id) => void openById(id),
              onJob: (job) => {
                setDetail(job)
                setJobs((prev) => prev?.map((item) => (item.id === current.id ? { ...item, ...job } : item)) ?? null)
              },
            }}
          />
        ) : jobs && jobs.length > 0 ? (
          <Empty title={t("Pick a job on the left")} />
        ) : null}
      </section>
    </div>
  )
}
