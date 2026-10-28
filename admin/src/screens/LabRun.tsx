import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { api, ApiError, UnauthorizedError } from "../api"
import { useInterval } from "../hooks"
import { useAction, useApp, useLoader } from "../app-context"
import { Empty, Flags, parseDate, Skeletons } from "../components/common"
import { useT } from "../i18n"
import { ConfirmDialog } from "../components/ConfirmDialog"
import { candidateName, elapsed, isLive, LABELED_STATUSES, runSize, type CloneSource } from "../lab-format"
import type { LabCell, LabJob, LabRunDetail, LabTrial } from "../types"
import { LabProgress, LabStatusBadge } from "./Lab"
import { JobPanel } from "./LabRunJobPanel"
import { DEFAULT_FILTERS, DIVERGENCE, type Filters, JobCell, MatrixCell, MatrixFilters } from "./LabRunMatrix"
import { CandidateCard, bestByMetric } from "./LabRunMetrics"

const POLL_MS = 3000
const TICK_MS = 15_000
function cellKey(candidateId: number, jobId: string): string {
  return `${candidateId}|${jobId}`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function LabRunScreen({
  id,
  onBack,
  onClone,
}: {
  id: number
  onBack: () => void
  onClone: (source: CloneSource) => void
}) {
  const t = useT()
  const run = useAction()
  const { notify, logout } = useApp()
  const [detail, setDetail] = useState<LabRunDetail | null>(null)
  const [missing, setMissing] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [openJob, setOpenJob] = useState<string | null>(null)
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS)
  const wasLive = useRef<boolean | null>(null)

  const load = useCallback(async () => {
    try {
      const result = await api.labRun(id)
      setDetail(result)
      setNow(Date.now())
      // Nobody is moving it — the walker died or handed it back; this tab takes over.
      if (result.run.stale) void api.labTick(id).catch(() => undefined)
    } catch (error) {
      if (error instanceof UnauthorizedError) logout()
      else if (error instanceof ApiError && error.status === 404) setMissing(true)
      else notify(messageOf(error), "error")
    }
  }, [id, logout, notify])

  useLoader(load)

  const live = detail ? isLive(detail.run.status) : false

  useInterval(() => void load(), POLL_MS, live)
  useInterval(() => void api.labTick(id).catch(() => undefined), TICK_MS, live)
  useInterval(() => setNow(Date.now()), 1000, live)

  useEffect(() => {
    if (!detail) return
    if (wasLive.current && !live) {
      const status = detail.run.status
      if (status === "done") notify(t("Run finished"))
      else if (status === "error") notify(detail.run.error || t("The run stopped"), "error")
    }
    wasLive.current = live
  }, [live, detail, notify])

  async function act(work: () => Promise<unknown>, success: string) {
    setBusy(true)
    const result = await run(work, success)
    setBusy(false)
    if (result) await load()
    return result
  }

  const indexes = useMemo(() => {
    const cells = new Map<string, LabCell>()
    const trials = new Map<string, LabTrial[]>()
    if (!detail) return { cells, trials }
    for (const cell of detail.cells) cells.set(cellKey(cell.candidate_id, cell.job_id), cell)
    for (const trial of detail.trials) {
      const key = cellKey(trial.candidate_id, trial.job_id)
      trials.set(key, [...(trials.get(key) ?? []), trial])
    }
    for (const list of trials.values()) list.sort((a, b) => a.repeat_no - b.repeat_no)
    return { cells, trials }
  }, [detail])

  const shown = useMemo(() => {
    if (!detail) return []
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

  if (missing) {
    return (
      <section className="card">
        <Empty title={t("Run not found")} hint={t("It may have been deleted.")} />
        <div className="row">
          <button className="btn btn-sm" onClick={onBack}>
            {t("← All runs")}
          </button>
        </div>
      </section>
    )
  }
  if (!detail) return <Skeletons count={3} />

  const labRun = detail.run
  const failedCount = detail.trials.filter((trial) => trial.status === "failed").length
  const started = parseDate(labRun.started_at ?? labRun.created_at)
  const finished = parseDate(labRun.finished_at)
  const summaryById = new Map(detail.summary.map((item) => [item.candidate_id, item]))
  const best = bestByMetric(detail.summary)

  function retryOne(trialId: number) {
    void act(() => api.retryLabRun(id, [trialId]), t("Attempt queued again"))
  }

  function clone() {
    onClone({
      id: labRun.id,
      name: labRun.name,
      repeats: labRun.repeats,
      jobs: detail!.jobs.length,
      user_name: labRun.user_name,
      candidates: detail!.candidates.map(({ provider, model, thinking_level, price_in_per_m, price_out_per_m }) => ({
        provider,
        model,
        thinking_level,
        price_in_per_m,
        price_out_per_m,
      })),
    })
  }

  return (
    <>
      <section className="card lab-run-head">
        <div className="lab-form-head">
          <button className="btn btn-ghost btn-sm" onClick={onBack}>
            {t("← All runs")}
          </button>
        </div>
        <div className="lab-run-title">
          <h2 className="lab-title">{labRun.name}</h2>
          <LabStatusBadge status={labRun.status} error={labRun.error} />
        </div>
        <div className="cell-sub lab-run-facts">
          <span>{t("Profile: {name}", { name: labRun.user_name ?? `#${labRun.user_id}` })}</span>
          <span>
            {runSize(detail.jobs.length, detail.candidates.length, labRun.repeats)}
          </span>
          <span>
            {labRun.sample_mode === "stratified" ? t("evenly across ranges") : t("random sample")}
            {labRun.include_labeled ? t(" + labeled") : ""}
          </span>
          <span>seed {labRun.seed}</span>
          <span title={t("SHA-256 of the system prompt: {hash}", { hash: labRun.prompt_hash })}>
            {t("prompt {hash}", { hash: labRun.prompt_hash.slice(0, 8) })}
          </span>
          {labRun.cloned_from ? <span>{t("clone #{id}", { id: labRun.cloned_from })}</span> : null}
        </div>

        <LabProgress done={labRun.done} total={labRun.total} failed={labRun.failed} />
        {started ? (
          <span className="muted">
            {live
              ? t("Running {time}", { time: elapsed(started.getTime(), (finished ?? new Date(now)).getTime()) })
              : t("Ran {time}", { time: elapsed(started.getTime(), (finished ?? new Date(now)).getTime()) })}
            {live && labRun.status === "queued" ? t(" · waiting for a free worker") : ""}
          </span>
        ) : null}

        {detail.cycle_running && live ? (
          <div className="lab-banner lab-banner-warning">
            {t(
              "A main run is in progress — the lab shares provider limits with it, so answers may arrive more slowly.",
            )}
          </div>
        ) : null}
        {labRun.error ? <div className="lab-banner lab-banner-negative">{labRun.error}</div> : null}

        <div className="row">
          {live ? (
            <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => setConfirmCancel(true)}>
              {t("Cancel run")}
            </button>
          ) : null}
          <button
            className="btn btn-sm"
            disabled={busy || failedCount === 0}
            onClick={() => void act(() => api.retryLabRun(id), t("Failed attempts queued again"))}
          >
            {t("Retry failed ({count})", { count: failedCount })}
          </button>
          <button className="btn btn-sm" disabled={busy} onClick={clone}>
            {t("Clone")}
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => void run(() => api.downloadLabCsv(id))}>
            {t("Export CSV")}
          </button>
        </div>
      </section>

      <section className="lab-summary">
        <div className="lab-summary-grid">
          {detail.candidates.map((candidate) => (
            <CandidateCard
              key={candidate.id}
              candidate={candidate}
              summary={summaryById.get(candidate.id)}
              best={best}
            />
          ))}
        </div>
        <p className="stat-hint lab-caption">
          {t(
            "Baseline is the current scorer's score, not the truth. Recall on labeled postings compares it with your real decisions. Likely baseline source: {model}. Hover a metric name to see the formula; n is how many postings or attempts it was computed on.",
            { model: labRun.baseline_model ?? t("unknown") },
          )}
        </p>
      </section>

      <section className="lab-matrix-section">
        <div className="card-title-row">
          <h3 className="card-title">{t("Matrix")}</h3>
          <span className="count">
            {shown.length === detail.jobs.length
              ? t("{count} postings", { count: shown.length })
              : t("{shown} of {total}", { shown: shown.length, total: detail.jobs.length })}
          </span>
        </div>
        <MatrixFilters value={filters} onChange={setFilters} />
        {shown.length === 0 ? (
          <section className="card">
            <Empty title={t("Nothing matches the filter")} />
          </section>
        ) : (
          <div className="table-wrap lab-matrix-wrap">
            <table className="table lab-matrix">
              <thead>
                <tr>
                  <th className="lab-sticky">{t("Posting")}</th>
                  <th>Baseline</th>
                  {detail.candidates.map((candidate) => (
                    <th key={candidate.id} title={candidate.model}>
                      {candidateName(candidate)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((job) => {
                  const open = openJob === job.job_id
                  return (
                    <Fragment key={job.job_id}>
                      <tr
                        className={`lab-row ${open ? "is-open" : ""}`}
                        onClick={() => setOpenJob(open ? null : job.job_id)}
                        aria-expanded={open}
                      >
                        <JobCell job={job} />
                        <td className="lab-baseline" title={job.baseline_reason ?? undefined}>
                          <span className="lab-baseline-score">{job.baseline_score ?? "—"}</span>
                          <Flags raw={job.baseline_flags} />
                        </td>
                        {detail.candidates.map((candidate) => {
                          const key = cellKey(candidate.id, job.job_id)
                          return (
                            <MatrixCell
                              key={candidate.id}
                              cell={indexes.cells.get(key)}
                              trials={indexes.trials.get(key) ?? []}
                              disabled={busy}
                              onRetry={retryOne}
                            />
                          )
                        })}
                      </tr>
                      {open ? (
                        <tr className="row-details">
                          <td colSpan={2 + detail.candidates.length}>
                            <JobPanel
                              runId={id}
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
      </section>

      {confirmCancel ? (
        <ConfirmDialog
          title={t("Cancel the run?")}
          confirmLabel={t("Cancel the run")}
          cancelLabel={t("Don't cancel")}
          busy={busy}
          onConfirm={() =>
            void act(() => api.cancelLabRun(id), t("Run cancelled")).then(() => setConfirmCancel(false))
          }
          onCancel={() => setConfirmCancel(false)}
        >
          {t("Queued attempts will not run. Ones already sent to a model will still be recorded.")}
        </ConfirmDialog>
      ) : null}
    </>
  )
}
