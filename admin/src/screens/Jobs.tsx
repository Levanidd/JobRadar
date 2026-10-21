import { Fragment, useCallback, useRef, useState } from "react"

import { api, type JobFilters, type JobSort } from "../api"
import { useAction, useApp, useLoader } from "../app-context"
import { getLang, useT } from "../i18n"
import { usePersistentState } from "../persist"
import { ConfirmDialog } from "../components/ConfirmDialog"
import { RefreshIcon } from "../components/icons"
import { JobCard, STATUS_LABELS, openOnDoubleClick } from "../components/JobCard"
import { MultiSelect } from "../components/MultiSelect"
import { SortHeader } from "../components/SortHeader"
import { Age, Count, Empty, Flags, ScoreBadge, Skeletons, formatSalary, plural } from "../components/common"
import type { CompanyFacet, Job, JobStatus } from "../types"

/**
 * Every status still gets a label on the card, but only these three are worth
 * browsing by. The application pipeline has a tab of its own, `notified` and
 * `off_profile` are bookkeeping the machine does, and "All"
 * already brings the prefiltered pile back.
 */
const FILTER_STATUSES: JobStatus[] = ["new", "saved", "ignored"]

const DEFAULT_DIR: Record<JobSort, "asc" | "desc"> = {
  applied: "desc",
  viewed: "desc",
  later: "desc",
  title: "asc",
  company: "asc",
  score: "desc",
  posted: "desc",
  updated: "desc",
  added: "desc",
}

type MarkFilter = "new" | "" | "applied" | "later" | "viewed"

function markFlags(mark: MarkFilter): Pick<JobFilters, "applied" | "later" | "viewed"> {
  if (mark === "new") return { applied: "no", later: "no", viewed: "no" }
  return {
    applied: mark === "applied" ? "yes" : undefined,
    later: mark === "later" ? "yes" : undefined,
    viewed: mark === "viewed" ? "yes" : undefined,
  }
}

function markOf(filters: JobFilters): MarkFilter {
  if (filters.applied === "yes") return "applied"
  if (filters.later === "yes") return "later"
  if (filters.viewed === "yes") return "viewed"
  if (filters.applied === "no" && filters.later === "no" && filters.viewed === "no") return "new"
  return ""
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

function withTitle(template: string, title: string) {
  const [before, after = ""] = template.split("{title}")
  return (
    <>
      {before}
      <b>{title}</b>
      {after}
    </>
  )
}

const DEFAULT_FILTERS: JobFilters = {
  min_score: 50,
  sort: "score",
  dir: "desc",
  ...markFlags("new"),
}

function str(raw: unknown): string | undefined {
  return typeof raw === "string" && raw ? raw : undefined
}

function num(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined
}

/**
 * Filters are read back field by field because the stored set outlives the
 * deploy that wrote it. The source filter is dropped on purpose: it only ever
 * arrives with a preset from the Sources tab, so restoring it would open the
 * tab on a source nobody picked.
 */
function reviveFilters(raw: unknown): JobFilters | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const stored = raw as Record<string, unknown>
  const companies = Array.isArray(stored.companies)
    ? stored.companies.filter((item): item is string => typeof item === "string")
    : []
  const status = str(stored.status)
  return {
    status: status === "any" || FILTER_STATUSES.includes(status as JobStatus) ? status : undefined,
    tier: str(stored.tier),
    min_score: num(stored.min_score) === 55 ? 50 : (num(stored.min_score) ?? 0),
    added_days: num(stored.added_days),
    added_from: str(stored.added_from),
    // These three used to be separate dropdowns; they are one mark now, so
    // an old stored set that had more than one «yes» keeps the strongest.
    ...markFlags(
      stored.applied === "yes"
        ? "applied"
        : stored.later === "yes"
          ? "later"
          : stored.viewed === "yes"
            ? "viewed"
            : stored.applied === "no" && stored.later === "no" && stored.viewed === "no"
              ? "new"
              : "",
    ),
    companies: companies.length > 0 ? companies : undefined,
    sort: typeof stored.sort === "string" && stored.sort in DEFAULT_DIR ? (stored.sort as JobSort) : "score",
    dir: stored.dir === "asc" ? "asc" : "desc",
  }
}

export function Jobs({
  preset,
  onOpenCompany,
}: {
  preset?: JobFilters
  onOpenCompany: (company: { company_key: string }) => void
}) {
  const t = useT()
  const run = useAction()
  const { notify } = useApp()
  const [filters, setFilters] = usePersistentState<JobFilters>(
    "jobs.filters",
    { ...DEFAULT_FILTERS, ...(preset ? markFlags("") : {}), ...preset },
    reviveFilters,
    { store: !preset },
  )
  const [jobs, setJobs] = useState<Job[] | null>(null)
  const [companies, setCompanies] = useState<CompanyFacet[]>([])
  const [card, setCard] = useState<Job | null>(null)
  const [scoring, setScoring] = useState<string | null>(null)
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null)
  const [pending, setPending] = useState<
    | { kind: "viewed"; job: Job; next: boolean }
    | { kind: "applied-off"; job: Job }
    | null
  >(null)
  const [confirming, setConfirming] = useState(false)
  // "From a date…" has to stay picked while the date field is still empty, which the
  // filters alone cannot say.
  const [customAdded, setCustomAdded] = useState(false)

  // Unchecking "applied" should not erase where the job stood before.
  const previous = useRef(new Map<string, JobStatus>())

  const {
    status,
    min_score: minScore,
    tier,
    added_days: addedDays,
    added_from: addedFrom,
    source_id: sourceId,
    viewed,
    later,
    applied,
  } = filters
  const picked = filters.companies ?? []

  const load = useCallback(async (silent = false) => {
    if (!silent) setJobs(null)
    const result = await run(() => api.jobs(filters))
    if (result) setJobs(result.jobs)
  }, [run, filters])

  useLoader(load)

  // The picker follows every filter except the company list itself.
  const loadCompanies = useCallback(async () => {
    const result = await run(() =>
      api.jobCompanies({
        status,
        min_score: minScore,
        tier,
        added_days: addedDays,
        added_from: addedFrom,
        source_id: sourceId,
        viewed,
        later,
        applied,
      }),
    )
    if (result) setCompanies(result.companies)
  }, [run, status, minScore, tier, addedDays, addedFrom, sourceId, viewed, later, applied])

  useLoader(loadCompanies)

  /** A row the edit just pushed out of the filter should leave, as a refetch would drop it. */
  function stillMatches(job: Job): boolean {
    if (viewed && Boolean(job.viewed_at) !== (viewed === "yes")) return false
    if (later && Boolean(job.later_at) !== (later === "yes")) return false
    if (applied && Boolean(job.applied_at) !== (applied === "yes")) return false
    return true
  }

  function patchJob(id: string, next: Partial<Job>) {
    setJobs(
      (prev) => prev?.map((item) => (item.id === id ? { ...item, ...next } : item)).filter(stillMatches) ?? null,
    )
    setCard((prev) => (prev && prev.id === id ? { ...prev, ...next } : prev))
  }

  /** The list carries no description, so the card fills itself in on open. */
  async function openCard(job: Job) {
    setCard(job)
    const result = await run(() => api.job(job.id))
    if (result) setCard((prev) => (prev && prev.id === job.id ? result.job : prev))
  }

  async function setStatus(job: Job, next: JobStatus) {
    const result = await run(() => api.setJobStatus(job.id, next))
    if (!result) return
    patchJob(job.id, {
      status: result.status,
      applied_at: result.applied_at,
      viewed_at: result.viewed_at,
      later_at: result.later_at,
      interviewed_at: result.interviewed_at,
    })
  }

  async function toggleLater(job: Job) {
    const result = await run(() => api.setJobLater(job.id, !job.later_at))
    if (result) patchJob(job.id, { later_at: result.later_at })
  }

  function inPipeline(job: Job): boolean {
    return Boolean(job.applied_at) || job.status === "applied" || job.status === "interview"
  }

  function applyScores(
    updates: Array<{
      id: string
      score: number
      score_reason: string | null
      flags: string | null
      status: JobStatus
    }>,
  ) {
    const byId = new Map(updates.map((item) => [item.id, item]))
    setJobs(
      (prev) =>
        prev?.map((item) => {
          const next = byId.get(item.id)
          return next
            ? {
                ...item,
                score: next.score,
                score_reason: next.score_reason,
                flags: next.flags,
                status: next.status,
              }
            : item
        }) ?? null,
    )
  }

  async function rescore(job: Job) {
    setScoring(job.id)
    const result = await run(() => api.scoreJob(job.id))
    setScoring(null)
    if (!result) return
    notify(`Score ${result.score}`)
    applyScores([result])
  }

  async function rescoreFiltered() {
    if (!jobs?.length || batch) return
    const ids = jobs.map((job) => job.id)
    setBatch({ done: 0, total: ids.length })
    let done = 0
    try {
      for (let i = 0; i < ids.length; i += 10) {
        const chunk = ids.slice(i, i + 10)
        const result = await run(() => api.scoreJobs(chunk))
        if (!result) return
        applyScores(result.jobs)
        done += result.jobs.length
        setBatch({ done, total: ids.length })
      }
      notify(
        t("Rescored {count} {noun}", {
          count: done,
          noun: plural(done, countForms(t, "job", "a few jobs", "jobs")),
        }),
      )
    } finally {
      setBatch(null)
    }
  }

  async function toggleApplied(job: Job) {
    if (inPipeline(job)) {
      setPending({ kind: "applied-off", job })
      return
    }
    previous.current.set(job.id, job.status)
    await setStatus(job, "applied")
  }

  function requestViewed(job: Job, next: boolean) {
    setPending({ kind: "viewed", job, next })
  }

  async function confirmPending() {
    if (!pending) return
    setConfirming(true)
    if (pending.kind === "applied-off") {
      await setStatus(pending.job, previous.current.get(pending.job.id) ?? "saved")
    } else {
      const result = await run(() => api.setJobViewed(pending.job.id, pending.next))
      if (result) patchJob(pending.job.id, { viewed_at: result.viewed_at })
    }
    setConfirming(false)
    setPending(null)
  }

  function sortBy(column: JobSort) {
    setFilters((prev) => {
      const dir = prev.sort === column ? (prev.dir === "asc" ? "desc" : "asc") : DEFAULT_DIR[column]
      return { ...prev, sort: column, dir }
    })
  }

  const sort = filters.sort ?? "score"
  const dir = filters.dir ?? "desc"
  const addedMode = filters.added_from || customAdded ? "custom" : String(filters.added_days ?? "")

  if (card) {
    return (
      <JobCard
        job={card}
        onBack={() => setCard(null)}
        list={jobs}
        onSelect={(job) => void openCard(job)}
        onPatch={(next) => patchJob(card.id, next)}
        onStatus={(next) => {
          if (next === "applied" && !inPipeline(card)) previous.current.set(card.id, card.status)
          void setStatus(card, next)
        }}
        onOpenCompany={onOpenCompany}
        onJob={(next) => {
          setJobs((prev) => prev?.map((item) => (item.id === card.id ? { ...item, ...next } : item)) ?? null)
          setCard(next)
        }}
        scoreExtra={
          <button
            type="button"
            className="icon-btn"
            title={t("Rescore")}
            disabled={Boolean(scoring === card.id || batch)}
            onClick={() => void rescore(card)}
          >
            <RefreshIcon className={scoring === card.id ? "is-spinning" : ""} />
          </button>
        }
      >
        {card.score_reason ? (
          <p className="muted">
            {card.score_reason === "prefilter"
              ? t("Filtered out by title: it missed the prefilter tags and never reached scoring")
              : card.score_reason}
          </p>
        ) : null}
        <Flags raw={card.flags} />
        <div className="row-tight" style={{ flexWrap: "wrap" }}>
          <span className="badge badge-neutral">{card.tier === "watchlist" ? "watchlist" : "discovery"}</span>
          <span className="badge badge-neutral">{card.source_label}</span>
        </div>
      </JobCard>
    )
  }

  return (
    <>
      <div className="filters">
        <select
          className="select"
          value={filters.tier ?? ""}
          onChange={(event) => setFilters((prev) => ({ ...prev, tier: event.target.value || undefined }))}
        >
          <option value="">{t("All")}</option>
          <option value="watchlist">Watchlist</option>
          <option value="discovery">Discovery</option>
        </select>

        <select
          className="select"
          value={String(filters.min_score ?? 0)}
          onChange={(event) => setFilters((prev) => ({ ...prev, min_score: Number(event.target.value) }))}
        >
          <option value="0">{t("All")}</option>
          <option value="40">{t("From {score}", { score: 40 })}</option>
          <option value="50">{t("From {score}", { score: 50 })}</option>
          <option value="70">{t("From {score}", { score: 70 })}</option>
          <option value="85">{t("From {score}", { score: 85 })}</option>
        </select>

        <select
          className="select"
          value={filters.status ?? ""}
          onChange={(event) => {
            const next = event.target.value || undefined
            // Prefiltered jobs were never scored, so a score threshold would
            // silently empty the very list the user just asked for.
            setFilters((prev) => ({
              ...prev,
              status: next,
              min_score: next === "any" ? 0 : prev.min_score,
            }))
          }}
        >
          <option value="">{t("On profile")}</option>
          <option value="any">{t("All")}</option>
          {FILTER_STATUSES.map((item) => (
            <option key={item} value={item}>
              {STATUS_LABELS[item]}
            </option>
          ))}
        </select>

        <select
          className="select"
          value={markOf(filters)}
          onChange={(event) =>
            setFilters((prev) => ({ ...prev, ...markFlags(event.target.value as MarkFilter) }))
          }
        >
          <option value="new">{t("New")}</option>
          <option value="applied">{STATUS_LABELS.applied}</option>
          <option value="later">{t("Later")}</option>
          <option value="viewed">{t("Viewed")}</option>
          <option value="">{t("All")}</option>
        </select>

        <select
          className="select"
          value={addedMode}
          onChange={(event) => {
            const value = event.target.value
            setCustomAdded(value === "custom")
            setFilters((prev) => ({
              ...prev,
              added_days: value && value !== "custom" ? Number(value) : undefined,
              added_from: undefined,
            }))
          }}
        >
          <option value="">{t("All")}</option>
          <option value="1">{t("Today")}</option>
          <option value="3">{t("Last 3 days")}</option>
          <option value="7">{t("Last week")}</option>
          <option value="30">{t("Last month")}</option>
          <option value="custom">{t("From a date…")}</option>
        </select>

        {addedMode === "custom" ? (
          <input
            className="input"
            type="date"
            title={t("Added no earlier than this date")}
            value={filters.added_from ?? ""}
            onChange={(event) =>
              setFilters((prev) => ({
                ...prev,
                added_from: event.target.value || undefined,
                added_days: undefined,
              }))
            }
          />
        ) : null}

        {filters.source_id ? (
          <button
            type="button"
            className="btn btn-sm"
            title={t("Clear the source filter")}
            onClick={() =>
              setFilters((prev) => ({ ...prev, source_id: undefined, source_label: undefined }))
            }
          >
            {t("Source: {name} ×", { name: filters.source_label ?? filters.source_id ?? "" })}
          </button>
        ) : null}

        <MultiSelect
          label={t("All")}
          options={companies.map((item) => ({
            value: item.company_key,
            label: item.company,
            hint: String(item.jobs),
          }))}
          selected={picked}
          onChange={(values) => setFilters((prev) => ({ ...prev, companies: values.length ? values : undefined }))}
        />
      </div>

      {jobs === null ? (
        <Skeletons />
      ) : jobs.length === 0 ? (
        <Empty title={t("Nothing found")} hint={t("Loosen the filters or start a run.")} />
      ) : (
        <>
          <div className="row">
            <Count shown={jobs.length} forms={countForms(t, "job", "a few jobs", "jobs")}>
              {filters.source_label ? ` · ${filters.source_label}` : ""}
              {picked.length > 0 ? ` · ${t("{count} companies in the filter", { count: picked.length })}` : ""}
              {batch ? ` · ${t("scoring {done} of {total}", { done: batch.done, total: batch.total })}` : ""}
            </Count>
            <button
              type="button"
              className="btn btn-sm"
              disabled={Boolean(scoring || batch)}
              onClick={() => void rescoreFiltered()}
            >
              {batch ? t("Scoring…") : t("Rescore all")}
            </button>
          </div>

          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <SortHeader
                    column="applied"
                    label={STATUS_LABELS.applied}
                    sort={sort}
                    dir={dir}
                    onSort={sortBy}
                    className="col-check"
                    title={t("Check this if you applied")}
                  />
                  <SortHeader
                    column="viewed"
                    label={t("Viewed")}
                    sort={sort}
                    dir={dir}
                    onSort={sortBy}
                    className="col-check"
                    title={t("Check this if you already viewed the job")}
                  />
                  <SortHeader
                    column="later"
                    label={t("Later")}
                    sort={sort}
                    dir={dir}
                    onSort={sortBy}
                    className="col-check"
                    title={t("Set aside to come back to the job")}
                  />
                  <SortHeader column="title" label={t("Job")} sort={sort} dir={dir} onSort={sortBy} />
                  <SortHeader column="company" label={t("Company")} sort={sort} dir={dir} onSort={sortBy} className="col-company" />
                  <SortHeader column="score" label="Score" sort={sort} dir={dir} onSort={sortBy} className="col-score" />
                  <SortHeader
                    column="posted"
                    label={t("Posted")}
                    sort={sort}
                    dir={dir}
                    onSort={sortBy}
                    className="col-date"
                  />
                  <SortHeader
                    column="added"
                    label={t("Added")}
                    sort={sort}
                    dir={dir}
                    onSort={sortBy}
                    className="col-date"
                    title={t("When we first saw the job")}
                  />
                  <SortHeader
                    column="updated"
                    label={t("Updated")}
                    sort={sort}
                    dir={dir}
                    onSort={sortBy}
                    className="col-date"
                    title={t("When the job changed at the source")}
                  />
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => {
                  const pay = formatSalary(job.salary_min, job.salary_max, job.salary_currency)
                  return (
                  <Fragment key={job.id}>
                    <tr
                      className={`row-open ${job.viewed_at && !inPipeline(job) ? "is-viewed" : ""} ${inPipeline(job) ? "is-applied" : ""} ${scoring === job.id || batch ? "is-busy" : ""}`.trim()}
                      title={t("Double-click to open the card")}
                      onDoubleClick={openOnDoubleClick(() => void openCard(job))}
                    >
                      <td className="col-check">
                        <input
                          type="checkbox"
                          className="checkbox"
                          checked={inPipeline(job)}
                          aria-label={t("Applied: {title}", { title: job.title })}
                          onChange={() => void toggleApplied(job)}
                        />
                      </td>
                      <td className="col-check">
                        <input
                          type="checkbox"
                          className="checkbox"
                          checked={Boolean(job.viewed_at)}
                          aria-label={t("Viewed: {title}", { title: job.title })}
                          onChange={(event) => requestViewed(job, event.target.checked)}
                        />
                      </td>
                      <td className="col-check">
                        <input
                          type="checkbox"
                          className="checkbox"
                          checked={Boolean(job.later_at)}
                          aria-label={t("View later: {title}", { title: job.title })}
                          onChange={() => void toggleLater(job)}
                        />
                      </td>
                      <td>
                        <a href={job.url} target="_blank" rel="noreferrer">
                          {job.title}
                        </a>
                        <div className="cell-sub">
                          <span className="cell-company-inline">{job.company}</span>
                          {job.location ? <span>{job.location}</span> : null}
                          {pay ? <span>{pay}</span> : null}
                        </div>
                      </td>
                      <td className="col-company">
                        <button
                          type="button"
                          className="cell-link"
                          title={t("All jobs at {company}", { company: job.company })}
                          onClick={() => onOpenCompany(job)}
                        >
                          {job.company}
                        </button>
                      </td>
                      <td className="col-score">
                        <div className="score-cell">
                          <ScoreBadge
                            score={job.status === "off_profile" ? null : job.score}
                            hint={t("Not scored: the title didn't match the profile")}
                          />
                          <button
                            type="button"
                            className="icon-btn"
                            title={t("Rescore")}
                            aria-label={t("Rescore: {title}", { title: job.title })}
                            disabled={Boolean(scoring === job.id || batch)}
                            onClick={() => void rescore(job)}
                          >
                            <RefreshIcon className={scoring === job.id ? "is-spinning" : ""} />
                          </button>
                        </div>
                      </td>
                      <td className="col-date">
                        <Age value={job.posted_at ?? job.first_seen_at} />
                        {job.posted_at ? null : <div className="cell-sub">{t("found by us")}</div>}
                      </td>
                      <td className="col-date">
                        <Age value={job.first_seen_at} warnAfter={14} />
                      </td>
                      <td className="col-date">
                        <Age value={job.changed_at ?? job.first_seen_at} warnAfter={7} />
                      </td>
                    </tr>
                  </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {pending ? (
        <ConfirmDialog
          title={
            pending.kind === "applied-off"
              ? t("Clear the applied mark?")
              : pending.next
                ? t("Mark as viewed?")
                : t("Clear the viewed mark?")
          }
          confirmLabel={pending.kind === "applied-off" || !pending.next ? t("Yes, clear it") : t("Yes, I viewed it")}
          cancelLabel={t("No")}
          busy={confirming}
          onCancel={() => !confirming && setPending(null)}
          onConfirm={() => void confirmPending()}
        >
          {pending.kind === "applied-off"
            ? withTitle(t("The job {title} will leave Applied."), pending.job.title)
            : pending.next
              ? withTitle(t("{title} will be marked as viewed."), pending.job.title)
              : withTitle(t("Viewed will be cleared from {title}."), pending.job.title)}
        </ConfirmDialog>
      ) : null}
    </>
  )
}
