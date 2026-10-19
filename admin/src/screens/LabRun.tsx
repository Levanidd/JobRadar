import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MouseEvent,
  type SetStateAction,
} from "react"

import { api, ApiError, UnauthorizedError } from "../api"
import { useAction, useApp, useLoader } from "../app-context"
import { Empty, Flags, parseDate, Skeletons } from "../components/common"
import { ConfirmDialog } from "../components/ConfirmDialog"
import { STATUS_LABELS, STATUS_TONE } from "../components/JobCard"
import {
  candidateName,
  compactTokens,
  decimal,
  elapsed,
  ERROR_SHORT,
  isLive,
  LABELED_STATUSES,
  ms,
  percent,
  runSize,
  shortModel,
  signed,
  STRATUM_LABEL,
  usd,
  type CloneSource,
} from "../lab-format"
import type {
  LabCandidate,
  LabCell,
  LabJob,
  LabJobDetail,
  LabRunDetail,
  LabStratum,
  LabSummary,
  LabTrial,
} from "../types"
import { LabProgress, LabStatusBadge } from "./Lab"

const POLL_MS = 3000
const TICK_MS = 15_000
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

type Metric = {
  key: string
  label: string
  hint: string
  /** Which way is better; metrics without one are shown but never highlighted. */
  better?: "low" | "high"
  score?: (summary: LabSummary) => number | null
  render: (summary: LabSummary) => string
  n?: (summary: LabSummary) => number
}

function errorShare(summary: LabSummary): number | null {
  const finished = summary.n_ok + summary.n_failed
  return finished ? summary.n_failed / finished : null
}

const METRICS: Metric[] = [
  {
    key: "mae",
    label: "MAE к baseline",
    hint: "Среднее |Δ| между средним скором модели и оценкой из базы, по вакансиям",
    better: "low",
    score: (s) => s.mae,
    render: (s) => decimal(s.mae),
    n: (s) => s.n.mae,
  },
  {
    key: "sd",
    label: "Стабильность, SD",
    hint: "Среднее стандартное отклонение скоров между повторами внутри вакансии",
    better: "low",
    score: (s) => s.stability_sd,
    render: (s) => decimal(s.stability_sd),
    n: (s) => s.n.stability,
  },
  {
    key: "flip",
    label: "Flip rate",
    hint: "Доля вакансий, где повторы оказались по разные стороны порога 70",
    better: "low",
    score: (s) => s.flip_rate,
    render: (s) => percent(s.flip_rate),
    n: (s) => s.n.flip,
  },
  {
    key: "agree",
    label: "Agreement @70",
    hint: "Доля вакансий, где решение «пинг / не пинг» по большинству повторов совпало с baseline",
    better: "high",
    score: (s) => s.agreement70,
    render: (s) => percent(s.agreement70),
    n: (s) => s.n.agreement,
  },
  {
    key: "recall",
    label: "Recall на размеченных",
    hint: "Доля вакансий, куда вы подались, прошли интервью или сохранили, где средний скор ≥ 70",
    better: "high",
    score: (s) => s.labeled_recall,
    render: (s) => percent(s.labeled_recall),
    n: (s) => s.n.labeled,
  },
  {
    key: "german",
    label: "Флаг «немецкий»",
    hint: "Доля вакансий, где german_required совпал с baseline",
    better: "high",
    score: (s) => s.german_flag_match,
    render: (s) => percent(s.german_flag_match),
    n: (s) => s.n.german,
  },
  {
    key: "errors",
    label: "Ошибки",
    hint: "Упавшие попытки от всех завершённых",
    better: "low",
    score: errorShare,
    render: (s) => `${percent(errorShare(s))} · ${s.n_failed} из ${s.n_ok + s.n_failed}`,
  },
  {
    key: "p50",
    label: "Латентность p50 / p95",
    hint: "Медиана и 95-й перцентиль длительности успешной попытки",
    better: "low",
    score: (s) => s.p50_ms,
    render: (s) => `${ms(s.p50_ms)} / ${ms(s.p95_ms)}`,
    n: (s) => s.n.latency,
  },
  {
    key: "tokens",
    label: "Токены вх / исх / мысли",
    hint: "Среднее на попытку; исходящие включают рассуждения",
    render: (s) => `${compactTokens(s.avg_in)} / ${compactTokens(s.avg_out)} / ${compactTokens(s.avg_thought)}`,
    n: (s) => s.n.tokens,
  },
  {
    key: "cost",
    label: "Стоимость прогона",
    hint: "Токены × цена модели за миллион",
    better: "low",
    score: (s) => s.cost_usd,
    render: (s) => usd(s.cost_usd),
  },
  {
    key: "per_job",
    label: "За вакансию",
    hint: "Средняя стоимость одной попытки",
    better: "low",
    score: (s) => s.cost_per_job_usd,
    render: (s) => usd(s.cost_per_job_usd),
  },
  {
    key: "monthly",
    label: "Прогноз в месяц",
    hint: "Стоимость за вакансию × 9 000 вакансий в месяц",
    better: "low",
    score: (s) => s.monthly_usd,
    render: (s) => usd(s.monthly_usd),
  },
]

/** Candidates holding the best value per metric; nothing when fewer than two compare or all tie. */
function bestByMetric(summary: LabSummary[]): Map<string, Set<number>> {
  const best = new Map<string, Set<number>>()
  for (const metric of METRICS) {
    if (!metric.better || !metric.score) continue
    const scored = summary.flatMap((item) => {
      const value = metric.score!(item)
      return value === null ? [] : [{ id: item.candidate_id, value }]
    })
    if (scored.length < 2) continue
    const values = scored.map((item) => item.value)
    const target = metric.better === "low" ? Math.min(...values) : Math.max(...values)
    if (values.every((value) => value === target)) continue
    best.set(metric.key, new Set(scored.filter((item) => item.value === target).map((item) => item.id)))
  }
  return best
}

function cellKey(candidateId: number, jobId: string): string {
  return `${candidateId}|${jobId}`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function quiet(action: () => void) {
  return (event: MouseEvent) => {
    event.stopPropagation()
    action()
  }
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

  useEffect(() => {
    if (!live) return
    const poll = window.setInterval(() => void load(), POLL_MS)
    const tick = window.setInterval(() => void api.labTick(id).catch(() => undefined), TICK_MS)
    const clock = window.setInterval(() => setNow(Date.now()), 1000)
    return () => {
      window.clearInterval(poll)
      window.clearInterval(tick)
      window.clearInterval(clock)
    }
  }, [live, load, id])

  useEffect(() => {
    if (!detail) return
    if (wasLive.current && !live) {
      const status = detail.run.status
      if (status === "done") notify("Прогон завершён")
      else if (status === "error") notify(detail.run.error || "Прогон оборвался", "error")
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
        <Empty title="Прогон не найден" hint="Возможно, его удалили." />
        <div className="row">
          <button className="btn btn-sm" onClick={onBack}>
            ← Все прогоны
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
    void act(() => api.retryLabRun(id, [trialId]), "Попытка снова в очереди")
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
            ← Все прогоны
          </button>
        </div>
        <div className="lab-run-title">
          <h2 className="lab-title">{labRun.name}</h2>
          <LabStatusBadge status={labRun.status} error={labRun.error} />
        </div>
        <div className="cell-sub lab-run-facts">
          <span>Профиль: {labRun.user_name ?? `#${labRun.user_id}`}</span>
          <span>
            {runSize(detail.jobs.length, detail.candidates.length, labRun.repeats)}
          </span>
          <span>
            {labRun.sample_mode === "stratified" ? "поровну по диапазонам" : "случайная выборка"}
            {labRun.include_labeled ? " + размеченные" : ""}
          </span>
          <span>seed {labRun.seed}</span>
          <span title={`SHA-256 системного промпта: ${labRun.prompt_hash}`}>промпт {labRun.prompt_hash.slice(0, 8)}</span>
          {labRun.cloned_from ? <span>клон #{labRun.cloned_from}</span> : null}
        </div>

        <LabProgress done={labRun.done} total={labRun.total} failed={labRun.failed} />
        {started ? (
          <span className="muted">
            {live ? "Идёт " : "Шёл "}
            {elapsed(started.getTime(), (finished ?? new Date(now)).getTime())}
            {live && labRun.status === "queued" ? " · ждёт свободного воркера" : ""}
          </span>
        ) : null}

        {detail.cycle_running && live ? (
          <div className="lab-banner lab-banner-warning">
            Идёт основной прогон — лаборатория делит с ним лимиты провайдеров, ответы могут приходить медленнее.
          </div>
        ) : null}
        {labRun.error ? <div className="lab-banner lab-banner-negative">{labRun.error}</div> : null}

        <div className="row">
          {live ? (
            <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => setConfirmCancel(true)}>
              Отменить
            </button>
          ) : null}
          <button
            className="btn btn-sm"
            disabled={busy || failedCount === 0}
            onClick={() => void act(() => api.retryLabRun(id), "Упавшие попытки снова в очереди")}
          >
            Повторить упавшие ({failedCount})
          </button>
          <button className="btn btn-sm" disabled={busy} onClick={clone}>
            Клонировать
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => void run(() => api.downloadLabCsv(id))}>
            Экспорт CSV
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
          Baseline — оценка текущего скорера, не истина. Recall на размеченных — сравнение с вашими реальными решениями.
          Вероятный источник baseline: {labRun.baseline_model ?? "неизвестен"}. Наведите на название метрики, чтобы
          увидеть формулу; n — на скольких вакансиях или попытках она посчитана.
        </p>
      </section>

      <section className="lab-matrix-section">
        <div className="card-title-row">
          <h3 className="card-title">Матрица</h3>
          <span className="count">
            {shown.length === detail.jobs.length ? `${shown.length} вакансий` : `${shown.length} из ${detail.jobs.length}`}
          </span>
        </div>
        <MatrixFilters value={filters} onChange={setFilters} />
        {shown.length === 0 ? (
          <section className="card">
            <Empty title="Под фильтр ничего не попало" />
          </section>
        ) : (
          <div className="table-wrap lab-matrix-wrap">
            <table className="table lab-matrix">
              <thead>
                <tr>
                  <th className="lab-sticky">Вакансия</th>
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
          title="Отменить прогон?"
          confirmLabel="Отменить прогон"
          cancelLabel="Не отменять"
          busy={busy}
          onConfirm={() =>
            void act(() => api.cancelLabRun(id), "Прогон отменён").then(() => setConfirmCancel(false))
          }
          onCancel={() => setConfirmCancel(false)}
        >
          Попытки из очереди не выполнятся. Те, что уже отправлены модели, допишутся.
        </ConfirmDialog>
      ) : null}
    </>
  )
}

function CandidateCard({
  candidate,
  summary,
  best,
}: {
  candidate: LabCandidate
  summary: LabSummary | undefined
  best: Map<string, Set<number>>
}) {
  return (
    <article className="card lab-metric-card">
      <header className="lab-metric-head">
        <div className="lab-metric-model" title={candidate.model}>
          {shortModel(candidate.model)}
        </div>
        <div className="row-tight">
          <span className="badge badge-neutral">{candidate.provider === "gemini" ? "Gemini" : "Nebius"}</span>
          {candidate.thinking_level ? (
            <span className="badge badge-accent">thinking {candidate.thinking_level.toLowerCase()}</span>
          ) : null}
        </div>
      </header>
      {summary ? (
        <dl className="lab-metrics">
          {METRICS.map((metric) => {
            const isBest = best.get(metric.key)?.has(candidate.id) ?? false
            return (
              <Fragment key={metric.key}>
                <dt title={metric.hint}>{metric.label}</dt>
                <dd className={isBest ? "is-best" : undefined}>
                  {metric.render(summary)}
                  {metric.n ? <span className="lab-n">n={metric.n(summary)}</span> : null}
                </dd>
              </Fragment>
            )
          })}
        </dl>
      ) : (
        <p className="muted">Ответов ещё нет</p>
      )}
    </article>
  )
}

function MatrixFilters({ value, onChange }: { value: Filters; onChange: Dispatch<SetStateAction<Filters>> }) {
  const toggles: Array<{ key: "diverge" | "errors" | "labeled"; label: string; hint: string }> = [
    {
      key: "diverge",
      label: "Только расхождения",
      hint: `|Δ| ≥ ${DIVERGENCE} у любой модели, flip или решение «пинг» не совпало с baseline`,
    },
    { key: "errors", label: "Только с ошибками", hint: "Есть хотя бы одна упавшая попытка" },
    { key: "labeled", label: "Только размеченные", hint: "Подался, интервью, сохранено или отказ" },
  ]
  return (
    <div className="lab-filters">
      {toggles.map((toggle) => (
        <button
          key={toggle.key}
          type="button"
          className="lab-filter"
          aria-pressed={value[toggle.key]}
          title={toggle.hint}
          onClick={() => onChange((current) => ({ ...current, [toggle.key]: !current[toggle.key] }))}
        >
          {toggle.label}
        </button>
      ))}
      <select
        className="select select-inline"
        aria-label="Диапазон выборки"
        value={value.stratum}
        onChange={(event) => {
          const stratum = event.target.value as Filters["stratum"]
          onChange((current) => ({ ...current, stratum }))
        }}
      >
        <option value="all">Все диапазоны</option>
        {(Object.keys(STRATUM_LABEL) as LabStratum[]).map((stratum) => (
          <option key={stratum} value={stratum}>
            {STRATUM_LABEL[stratum]}
          </option>
        ))}
      </select>
      <select
        className="select select-inline"
        aria-label="Сортировка"
        value={value.sort}
        onChange={(event) => {
          const sort = event.target.value as Sort
          onChange((current) => ({ ...current, sort }))
        }}
      >
        <option value="order">По порядку выборки</option>
        <option value="baseline">По baseline</option>
        <option value="delta">По максимальному |Δ|</option>
        <option value="spread">По разбросу</option>
      </select>
    </div>
  )
}

function JobCell({ job }: { job: LabJob }) {
  const status = job.baseline_status
  return (
    <td className="lab-sticky lab-job">
      <div className="lab-job-title">
        {job.url ? (
          <a href={job.url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>
            {job.title}
          </a>
        ) : (
          job.title
        )}
      </div>
      <div className="cell-sub">
        <span>{job.company}</span>
        {job.location ? <span>{job.location}</span> : null}
      </div>
      <div className="lab-job-badges">
        {status && status !== "new" ? (
          <span className={`badge ${STATUS_TONE[status] ?? "badge-neutral"}`}>{STATUS_LABELS[status]}</span>
        ) : null}
        {job.stratum ? <span className="badge badge-neutral">{STRATUM_LABEL[job.stratum]}</span> : null}
      </div>
    </td>
  )
}

function toneOf(mean: number | null | undefined): string {
  if (mean === null || mean === undefined) return ""
  return mean >= 70 ? "is-high" : mean >= 40 ? "is-mid" : "is-low"
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
  const warn = cell && (cell.flip || (cell.spread ?? 0) >= DIVERGENCE)
  return (
    <td className={`lab-cell ${toneOf(cell?.mean)}`}>
      <div className="lab-scores">
        {trials.map((trial) => (
          <TrialChip key={trial.id} trial={trial} disabled={disabled} onRetry={onRetry} />
        ))}
      </div>
      {cell && (cell.delta !== null || warn || cell.unstable_flags.length) ? (
        <div className="lab-cell-meta">
          {cell.delta !== null ? (
            <span className={Math.abs(cell.delta) >= DIVERGENCE ? "lab-delta is-far" : "lab-delta"}>
              Δ {signed(cell.delta)}
            </span>
          ) : null}
          {warn ? (
            <span
              className="lab-warn"
              title={cell.flip ? "Повторы оказались по разные стороны порога 70" : `Разброс между повторами ${cell.spread}`}
            >
              ⚠ {cell.flip ? "flip" : `разброс ${cell.spread}`}
            </span>
          ) : null}
          {cell.unstable_flags.length ? (
            <span className="lab-unstable" title="Флаги, которые встретились не во всех повторах">
              ⚑ {cell.unstable_flags.length}
            </span>
          ) : null}
        </div>
      ) : null}
    </td>
  )
}

function TrialChip({
  trial,
  disabled = false,
  onRetry,
}: {
  trial: LabTrial
  disabled?: boolean
  onRetry?: (trialId: number) => void
}) {
  if (trial.status === "ok") {
    return (
      <span className="lab-score" title={trial.reason ?? undefined}>
        {trial.score}
      </span>
    )
  }
  if (trial.status === "failed") {
    return (
      <span className="lab-fail" title={[trial.error_code, trial.error].filter(Boolean).join(": ") || undefined}>
        ✕ {ERROR_SHORT[trial.error_code ?? "error"] ?? trial.error_code}
        {onRetry ? (
          <button
            type="button"
            className="lab-retry"
            aria-label="Повторить попытку"
            title="Повторить попытку"
            disabled={disabled}
            onClick={quiet(() => onRetry(trial.id))}
          >
            ↻
          </button>
        ) : null}
      </span>
    )
  }
  if (trial.status === "running") {
    return <span className="lab-spinner" role="status" aria-label="Модель отвечает" />
  }
  if (trial.status === "pending") return <span className="lab-pending" aria-label="В очереди" />
  return (
    <span className="lab-cancelled" title="Отменена">
      —
    </span>
  )
}

function JobPanel({
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
  const run = useAction()
  const [detail, setDetail] = useState<LabJobDetail | null>(null)
  const [raw, setRaw] = useState(false)
  const finished = candidates.reduce(
    (sum, candidate) => sum + trialsFor(candidate.id).filter((trial) => trial.status === "ok" || trial.status === "failed").length,
    0,
  )

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

  return (
    <div className="lab-panel" onClick={(event) => event.stopPropagation()}>
      <div className="lab-panel-grid">
        <div className="lab-panel-block">
          <h4 className="lab-panel-title">Описание — ровно то, что ушло в модель</h4>
          {detail ? <div className="lab-description">{detail.job.description}</div> : <div className="skeleton lab-skeleton" />}
        </div>
        <div className="lab-panel-block">
          <h4 className="lab-panel-title">Baseline · {job.baseline_score ?? "—"}</h4>
          <p className="lab-reason">{job.baseline_reason || "Причина не сохранена"}</p>
          <Flags raw={job.baseline_flags} />
        </div>
      </div>

      <label className="check-inline">
        <input type="checkbox" className="checkbox" checked={raw} onChange={(event) => setRaw(event.target.checked)} />
        Показать сырой ответ модели
      </label>

      <div className="lab-panel-candidates">
        {candidates.map((candidate) => (
          <div key={candidate.id} className="lab-panel-block">
            <h4 className="lab-panel-title" title={candidate.model}>
              {candidateName(candidate)}
            </h4>
            {trialsFor(candidate.id).map((trial) => (
              <div key={trial.id} className="lab-trial">
                <div className="lab-trial-head">
                  <span className="muted">Повтор {trial.repeat_no}</span>
                  {trial.status === "ok" ? (
                    <span className={`lab-score ${toneOf(trial.score)}`}>{trial.score}</span>
                  ) : (
                    <TrialChip trial={trial} />
                  )}
                  <Flags raw={trial.flags} />
                  {trial.input_tokens !== null ? (
                    <span className="lab-trial-stats">
                      {compactTokens(trial.input_tokens)} / {compactTokens(trial.output_tokens)}
                      {trial.thought_tokens ? ` (мысли ${compactTokens(trial.thought_tokens)})` : ""} · {ms(trial.duration_ms)}
                      {trial.attempts > 1 ? ` · попыток ${trial.attempts}` : ""}
                    </span>
                  ) : null}
                </div>
                {trial.status === "failed" ? (
                  <p className="error-text">{trial.error}</p>
                ) : trial.reason ? (
                  <p className="lab-reason">{trial.reason}</p>
                ) : null}
                {raw && rawById.get(trial.id) ? <pre className="lab-raw">{rawById.get(trial.id)}</pre> : null}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
