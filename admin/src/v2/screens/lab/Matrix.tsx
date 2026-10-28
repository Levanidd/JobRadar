import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react"

import { api } from "../../../api"
import { useAction } from "../../../app-context"
import { statusLabel } from "../../../components/job-status"
import { useT } from "../../../i18n"
import {
  compactTokens,
  ERROR_SHORT,
  LABELED_STATUSES,
  ms,
  shortModel,
  signed,
  STRATUM_LABEL,
} from "../../../lab-format"
import type { JobStatus, LabCandidate, LabCell, LabJob, LabJobDetail, LabRunDetail, LabStratum, LabTrial } from "../../../types"
import { Empty, Icon, flagLabels } from "../../ui"
import { Swatch } from "./shared"

/** |Δ| or spread from here on counts as a disagreement, as in the current admin. */
const DIVERGENCE = 15

type Sort = "order" | "baseline" | "delta" | "spread"

type Filters = {
  diverge: boolean
  errors: boolean
  labeled: boolean
  stratum: LabStratum | "all"
  sort: Sort
}

const DEFAULT_FILTERS: Filters = { diverge: false, errors: false, labeled: false, stratum: "all", sort: "order" }

const STATUS_CHIP: Partial<Record<JobStatus, string>> = {
  applied: "chip-violet",
  interview: "chip-green",
  saved: "chip-amber",
  rejected: "chip-red",
}

function cellKey(candidateId: number, jobId: string): string {
  return `${candidateId}|${jobId}`
}

export function Matrix({
  detail,
  busy,
  onRetry,
}: {
  detail: LabRunDetail
  busy: boolean
  onRetry: (trialId: number) => void
}) {
  const t = useT()
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS)
  const [openJob, setOpenJob] = useState<string | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  // The expanded detail stays as wide as the visible part of the table, so a phone
  // reads it without scrolling sideways.
  useLayoutEffect(() => {
    const wrap = wrapRef.current
    if (!wrap || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => wrap.style.setProperty("--lab2-wrap-w", `${wrap.clientWidth}px`))
    observer.observe(wrap)
    return () => observer.disconnect()
  }, [])

  const indexes = useMemo(() => {
    const cells = new Map<string, LabCell>()
    const trials = new Map<string, LabTrial[]>()
    for (const cell of detail.cells) cells.set(cellKey(cell.candidate_id, cell.job_id), cell)
    for (const trial of detail.trials) {
      const key = cellKey(trial.candidate_id, trial.job_id)
      trials.set(key, [...(trials.get(key) ?? []), trial])
    }
    for (const list of trials.values()) list.sort((a, b) => a.repeat_no - b.repeat_no)
    return { cells, trials }
  }, [detail])

  const shown = useMemo(() => {
    const jobCells = (job: LabJob) =>
      detail.candidates.flatMap((candidate) => indexes.cells.get(cellKey(candidate.id, job.job_id)) ?? [])
    const maxDelta = (job: LabJob) => Math.max(-1, ...jobCells(job).map((cell) => Math.abs(cell.delta ?? -1)))
    const maxSpread = (job: LabJob) => Math.max(-1, ...jobCells(job).map((cell) => cell.spread ?? -1))
    const list = detail.jobs.filter((job) => {
      const cells = jobCells(job)
      if (filters.stratum !== "all" && job.stratum !== filters.stratum) return false
      if (filters.labeled && !LABELED_STATUSES.includes(job.baseline_status ?? "")) return false
      if (filters.errors && !cells.some((cell) => cell.n_failed > 0)) return false
      if (
        filters.diverge &&
        !cells.some((cell) => Math.abs(cell.delta ?? 0) >= DIVERGENCE || cell.flip || cell.agree === false)
      ) {
        return false
      }
      return true
    })
    const sorted = [...list]
    if (filters.sort === "baseline") sorted.sort((a, b) => (b.baseline_score ?? -1) - (a.baseline_score ?? -1))
    if (filters.sort === "delta") sorted.sort((a, b) => maxDelta(b) - maxDelta(a))
    if (filters.sort === "spread") sorted.sort((a, b) => maxSpread(b) - maxSpread(a))
    return sorted
  }, [detail, indexes, filters])

  const toggles: Array<{ key: "diverge" | "errors" | "labeled"; label: string; hint: string }> = [
    {
      key: "diverge",
      label: t("Only disagreements"),
      hint: t("|Δ| ≥ {n} for any model, a flip, or a ping decision that disagrees with the baseline", { n: DIVERGENCE }),
    },
    { key: "errors", label: t("Only with errors"), hint: t("At least one failed attempt") },
    { key: "labeled", label: t("Only labeled"), hint: t("Applied, interview, saved, or rejected") },
  ]

  const columns = 2 + detail.candidates.length

  return (
    <section className="card lab2-table-card" aria-labelledby="lab2-matrix-h">
      <div className="lab2-table-head lab2-matrix-head">
        <h2 id="lab2-matrix-h" className="lab2-h2">
          {t("Matrix")}
        </h2>
        <span className="lab2-caption">
          {shown.length === detail.jobs.length
            ? t("{count} postings", { count: shown.length })
            : t("{shown} of {total}", { shown: shown.length, total: detail.jobs.length })}
        </span>
        <div className="lab2-filters">
          {toggles.map((toggle) => (
            <button
              key={toggle.key}
              type="button"
              className="lab2-pill"
              aria-pressed={filters[toggle.key]}
              title={toggle.hint}
              onClick={() => setFilters((current) => ({ ...current, [toggle.key]: !current[toggle.key] }))}
            >
              {toggle.label}
            </button>
          ))}
          <label className="lab2-inline-select">
            <span>{t("Range")}</span>
            <select
              className="select"
              value={filters.stratum}
              onChange={(event) => {
                const stratum = event.target.value as Filters["stratum"]
                setFilters((current) => ({ ...current, stratum }))
              }}
            >
              <option value="all">{t("All ranges")}</option>
              {(Object.keys(STRATUM_LABEL) as LabStratum[]).map((stratum) => (
                <option key={stratum} value={stratum}>
                  {STRATUM_LABEL[stratum]}
                </option>
              ))}
            </select>
          </label>
          <label className="lab2-inline-select">
            <span>{t("Sort")}</span>
            <select
              className="select"
              value={filters.sort}
              onChange={(event) => {
                const sort = event.target.value as Sort
                setFilters((current) => ({ ...current, sort }))
              }}
            >
              <option value="order">{t("By sample order")}</option>
              <option value="delta">{t("By largest |Δ|")}</option>
              <option value="spread">{t("By spread")}</option>
              <option value="baseline">{t("By baseline")}</option>
            </select>
          </label>
        </div>
      </div>

      {shown.length === 0 ? (
        <Empty title={t("Nothing matches the filter")} />
      ) : (
        <div className="lab2-scroll" ref={wrapRef}>
          <table className="lab2-table lab2-matrix" style={{ minWidth: 380 + detail.candidates.length * 150 }}>
            <thead>
              <tr>
                <th scope="col" className="lab2-sticky">
                  {t("Posting")}
                </th>
                <th scope="col">{t("Baseline")}</th>
                {detail.candidates.map((candidate, index) => (
                  <th key={candidate.id} scope="col" title={candidate.model}>
                    <span className="lab2-model-head">
                      <Swatch index={index} size={8} />
                      <span className="mono">
                        {shortModel(candidate.model)}
                        {candidate.thinking_level ? ` · ${candidate.thinking_level.toLowerCase()}` : ""}
                      </span>
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((job) => {
                const open = openJob === job.job_id
                const toggle = () => setOpenJob(open ? null : job.job_id)
                return (
                  <Fragment key={job.job_id}>
                    <tr
                      className={`lab2-row${open ? " is-open" : ""}`}
                      onClick={(event: MouseEvent) => {
                        if ((event.target as HTMLElement).closest("a, button, select, input")) return
                        toggle()
                      }}
                    >
                      <JobCell job={job} open={open} onToggle={toggle} detailId={`lab2-detail-${job.position}`} />
                      <td className="lab2-baseline" title={job.baseline_reason ?? undefined}>
                        <span className="mono lab2-mean">{job.baseline_score ?? "—"}</span>
                        <FlagChips raw={job.baseline_flags} />
                      </td>
                      {detail.candidates.map((candidate) => {
                        const key = cellKey(candidate.id, job.job_id)
                        return (
                          <MatrixCell
                            key={candidate.id}
                            cell={indexes.cells.get(key)}
                            trials={indexes.trials.get(key) ?? []}
                            disabled={busy}
                            onRetry={onRetry}
                          />
                        )
                      })}
                    </tr>
                    {open ? (
                      <tr className="lab2-detail-row" id={`lab2-detail-${job.position}`}>
                        <td colSpan={columns}>
                          <JobDetail
                            runId={detail.run.id}
                            job={job}
                            candidates={detail.candidates}
                            trialsFor={(candidateId) => indexes.trials.get(cellKey(candidateId, job.job_id)) ?? []}
                          />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="lab2-foot">
        {t("Δ is the model mean minus the baseline. ⚠ flip: repeats landed on opposite sides of the 70 threshold.")}
      </p>
    </section>
  )
}

function FlagChips({ raw }: { raw: string | null }) {
  const flags = flagLabels(raw)
  if (!flags.length) return null
  return (
    <span className="lab2-flags">
      {flags.map((flag) => (
        <span key={flag} className="chip chip-red">
          {flag}
        </span>
      ))}
    </span>
  )
}

function JobCell({
  job,
  open,
  onToggle,
  detailId,
}: {
  job: LabJob
  open: boolean
  onToggle: () => void
  detailId: string
}) {
  const t = useT()
  const status = job.baseline_status
  return (
    <th scope="row" className="lab2-sticky lab2-job">
      <span className="lab2-job-line">
        <button
          type="button"
          className="lab2-job-title"
          aria-expanded={open}
          aria-controls={open ? detailId : undefined}
          onClick={onToggle}
        >
          <span className="lab2-chev" aria-hidden="true">
            <Icon name={open ? "up" : "down"} size={14} />
          </span>
          {job.title}
        </button>
        {job.url ? (
          <a
            className="lab2-job-ext"
            href={job.url}
            target="_blank"
            rel="noreferrer"
            aria-label={t("Open the posting")}
            title={t("Open the posting")}
          >
            <Icon name="external" size={13} />
          </a>
        ) : null}
      </span>
      <span className="lab2-job-sub">
        <span>{[job.company, job.location].filter(Boolean).join(" · ")}</span>
        {job.stratum ? <span className="lab2-range mono">{STRATUM_LABEL[job.stratum]}</span> : null}
        {status && status !== "new" && status !== "notified" ? (
          <span className={`chip ${STATUS_CHIP[status] ?? "chip-gray"} lab2-status`}>{statusLabel(status)}</span>
        ) : null}
      </span>
    </th>
  )
}

function MatrixCell({
  cell,
  trials,
  disabled,
  onRetry,
}: {
  cell: LabCell | undefined
  trials: LabTrial[]
  disabled: boolean
  onRetry: (trialId: number) => void
}) {
  const t = useT()
  const far = cell?.delta != null && Math.abs(cell.delta) >= DIVERGENCE
  const spread = !cell?.flip && (cell?.spread ?? 0) >= DIVERGENCE
  return (
    <td className="lab2-cell">
      <span className="lab2-cell-top">
        <span className="mono lab2-mean">{cell?.mean != null ? Math.round(cell.mean) : "—"}</span>
        {cell?.delta != null ? (
          <span className={`mono lab2-delta${far ? " is-far" : ""}`} title={t("Model mean minus the baseline")}>
            {signed(cell.delta)}
          </span>
        ) : null}
        {cell?.flip ? (
          <span className="lab2-warn" title={t("Repeats landed on opposite sides of the 70 threshold")}>
            ⚠ {t("flip")}
          </span>
        ) : spread ? (
          <span className="lab2-warn" title={t("Spread across repeats: {n}", { n: cell?.spread ?? 0 })}>
            ⚠ {t("spread {n}", { n: cell?.spread ?? 0 })}
          </span>
        ) : null}
        {cell?.unstable_flags.length ? (
          <span className="lab2-unstable" title={t("Flags that did not appear in every repeat")}>
            ⚑ {cell.unstable_flags.length}
          </span>
        ) : null}
      </span>
      <span className="lab2-scores">
        {trials.map((trial, index) => (
          <Fragment key={trial.id}>
            {index > 0 ? (
              <span className="faint" aria-hidden="true">
                ·
              </span>
            ) : null}
            <TrialMark trial={trial} disabled={disabled} onRetry={onRetry} />
          </Fragment>
        ))}
      </span>
    </td>
  )
}

function TrialMark({
  trial,
  disabled = false,
  onRetry,
}: {
  trial: LabTrial
  disabled?: boolean
  onRetry?: (trialId: number) => void
}) {
  const t = useT()
  if (trial.status === "ok") {
    return (
      <span className="mono" title={trial.reason ?? undefined}>
        {trial.score}
      </span>
    )
  }
  if (trial.status === "failed") {
    return (
      <span
        className="lab2-fail mono"
        title={[trial.error_code, trial.error].filter(Boolean).join(": ") || undefined}
      >
        ✕ {ERROR_SHORT[trial.error_code ?? "error"] ?? trial.error_code}
        {onRetry ? (
          <button
            type="button"
            className="lab2-retry"
            aria-label={t("Retry attempt")}
            title={t("Retry attempt")}
            disabled={disabled}
            onClick={() => onRetry(trial.id)}
          >
            ↻
          </button>
        ) : null}
      </span>
    )
  }
  if (trial.status === "running") {
    return <span className="lab2-spinner" role="status" aria-label={t("The model is responding")} />
  }
  if (trial.status === "pending") {
    return <span className="lab2-pending" role="img" aria-label={t("Queued")} title={t("Queued")} />
  }
  return (
    <span className="faint" title={t("Attempt cancelled")} aria-label={t("Attempt cancelled")}>
      —
    </span>
  )
}

function JobDetail({
  runId,
  job,
  candidates,
  trialsFor,
}: {
  runId: number
  job: LabJob
  candidates: LabCandidate[]
  trialsFor: (candidateId: number) => LabTrial[]
}) {
  const t = useT()
  const run = useAction()
  const [detail, setDetail] = useState<LabJobDetail | null>(null)
  const [showDescription, setShowDescription] = useState(false)
  const [raw, setRaw] = useState(false)
  const finished = candidates.reduce(
    (sum, candidate) =>
      sum + trialsFor(candidate.id).filter((trial) => trial.status === "ok" || trial.status === "failed").length,
    0,
  )

  // Raw responses arrive with each finished attempt, so a live run refetches as answers land.
  useEffect(() => {
    let cancelled = false
    void run(() => api.labJob(runId, job.job_id)).then((result) => {
      if (result && !cancelled) setDetail(result)
    })
    return () => {
      cancelled = true
    }
  }, [run, runId, job.job_id, finished])

  const rawById = new Map(detail?.trials.map((trial) => [trial.id, trial.raw_response]) ?? [])
  const descriptionId = `lab2-desc-${job.position}`

  return (
    <div className="lab2-detail">
      <div className="lab2-reasons">
        <div className="lab2-reason-card">
          <span className="lab2-reason-who">
            <span className="lab2-swatch lab2-swatch-base" aria-hidden="true" />
            {t("Baseline")} · <span className="mono">{job.baseline_score ?? "—"}</span>
          </span>
          <p className="lab2-reason">{job.baseline_reason || t("No reason was stored")}</p>
          <FlagChips raw={job.baseline_flags} />
        </div>
        {candidates.map((candidate, index) => (
          <div key={candidate.id} className="lab2-reason-card">
            <span className="lab2-reason-who" title={candidate.model}>
              <Swatch index={index} size={8} />
              <span className="mono">
                {shortModel(candidate.model)}
                {candidate.thinking_level ? ` · ${candidate.thinking_level.toLowerCase()}` : ""}
              </span>
            </span>
            {trialsFor(candidate.id).map((trial) => (
              <div key={trial.id} className="lab2-trial">
                <div className="lab2-trial-head">
                  <span className="faint">{t("Repeat {n}", { n: trial.repeat_no })}</span>
                  {trial.status === "ok" ? (
                    <span className="mono lab2-trial-score">{trial.score}</span>
                  ) : (
                    <TrialMark trial={trial} />
                  )}
                  <FlagChips raw={trial.flags} />
                  {trial.input_tokens !== null ? (
                    <span className="lab2-trial-stats mono">
                      {compactTokens(trial.input_tokens)} / {compactTokens(trial.output_tokens)}
                      {trial.thought_tokens ? t(" (thoughts {n})", { n: compactTokens(trial.thought_tokens) }) : ""} ·{" "}
                      {ms(trial.duration_ms)}
                      {trial.attempts > 1 ? t(" · attempts {n}", { n: trial.attempts }) : ""}
                    </span>
                  ) : null}
                </div>
                {trial.status === "failed" ? (
                  <p className="lab2-reason lab2-red">{trial.error}</p>
                ) : trial.reason ? (
                  <p className="lab2-reason">{trial.reason}</p>
                ) : null}
                {raw ? (
                  rawById.get(trial.id) ? (
                    <pre className="lab2-raw">{rawById.get(trial.id)}</pre>
                  ) : detail ? null : (
                    <div className="skeleton lab2-skeleton-line" />
                  )
                ) : null}
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="lab2-detail-links">
        <button
          type="button"
          className="btn-link"
          aria-expanded={showDescription}
          aria-controls={descriptionId}
          onClick={() => setShowDescription((value) => !value)}
        >
          {showDescription ? t("Hide the description") : t("Description, exactly as the model saw it")}
        </button>
        <button type="button" className="btn-link" aria-pressed={raw} onClick={() => setRaw((value) => !value)}>
          {raw ? t("Hide the raw responses") : t("Raw model responses")}
        </button>
      </div>
      {showDescription ? (
        <div id={descriptionId} className="lab2-description">
          <h3 className="lab2-label">{t("Description — exactly what was sent to the model")}</h3>
          {detail ? (
            <div className="lab2-description-text" tabIndex={0}>
              {detail.job.description}
            </div>
          ) : (
            <div className="skeleton" />
          )}
        </div>
      ) : null}
    </div>
  )
}
