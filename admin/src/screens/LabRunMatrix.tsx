import type { Dispatch, MouseEvent, SetStateAction } from "react"
import { useT } from "../i18n"
import { STATUS_LABELS, STATUS_TONE } from "../components/JobCard"
import { ERROR_SHORT, signed, STRATUM_LABEL } from "../lab-format"
import type { LabCell, LabJob, LabStratum, LabTrial } from "../types"

export const DIVERGENCE = 15

type Sort = "order" | "baseline" | "delta" | "spread"

export type Filters = {
  diverge: boolean
  errors: boolean
  labeled: boolean
  stratum: LabStratum | "all"
  sort: Sort
}

export const DEFAULT_FILTERS: Filters = { diverge: false, errors: false, labeled: false, stratum: "all", sort: "order" }

function quiet(action: () => void) {
  return (event: MouseEvent) => {
    event.stopPropagation()
    action()
  }
}

export function MatrixFilters({ value, onChange }: { value: Filters; onChange: Dispatch<SetStateAction<Filters>> }) {
  const t = useT()
  const toggles: Array<{ key: "diverge" | "errors" | "labeled"; label: string; hint: string }> = [
    {
      key: "diverge",
      label: t("Only disagreements"),
      hint: t("|Δ| ≥ {n} for any model, a flip, or a ping decision that disagrees with the baseline", {
        n: DIVERGENCE,
      }),
    },
    { key: "errors", label: t("Only with errors"), hint: t("At least one failed attempt") },
    { key: "labeled", label: t("Only labeled"), hint: t("Applied, interview, saved, or rejected") },
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
        aria-label={t("Sample range")}
        value={value.stratum}
        onChange={(event) => {
          const stratum = event.target.value as Filters["stratum"]
          onChange((current) => ({ ...current, stratum }))
        }}
      >
        <option value="all">{t("All ranges")}</option>
        {(Object.keys(STRATUM_LABEL) as LabStratum[]).map((stratum) => (
          <option key={stratum} value={stratum}>
            {STRATUM_LABEL[stratum]}
          </option>
        ))}
      </select>
      <select
        className="select select-inline"
        aria-label={t("Sort")}
        value={value.sort}
        onChange={(event) => {
          const sort = event.target.value as Sort
          onChange((current) => ({ ...current, sort }))
        }}
      >
        <option value="order">{t("By sample order")}</option>
        <option value="baseline">{t("By baseline")}</option>
        <option value="delta">{t("By largest |Δ|")}</option>
        <option value="spread">{t("By spread")}</option>
      </select>
    </div>
  )
}

export function JobCell({ job }: { job: LabJob }) {
  useT()
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

export function toneOf(mean: number | null | undefined): string {
  if (mean === null || mean === undefined) return ""
  return mean >= 70 ? "is-high" : mean >= 40 ? "is-mid" : "is-low"
}

export function MatrixCell({
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
              title={
                cell.flip
                  ? t("Repeats landed on opposite sides of the 70 threshold")
                  : t("Spread across repeats: {n}", { n: cell.spread ?? 0 })
              }
            >
              ⚠ {cell.flip ? "flip" : t("spread {n}", { n: cell.spread ?? 0 })}
            </span>
          ) : null}
          {cell.unstable_flags.length ? (
            <span className="lab-unstable" title={t("Flags that did not appear in every repeat")}>
              ⚑ {cell.unstable_flags.length}
            </span>
          ) : null}
        </div>
      ) : null}
    </td>
  )
}

export function TrialChip({
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
            aria-label={t("Retry attempt")}
            title={t("Retry attempt")}
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
    return <span className="lab-spinner" role="status" aria-label={t("The model is responding")} />
  }
  if (trial.status === "pending") return <span className="lab-pending" aria-label={t("Queued")} />
  return (
    <span className="lab-cancelled" title={t("Attempt cancelled")}>
      —
    </span>
  )
}
