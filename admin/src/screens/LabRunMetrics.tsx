import { Fragment } from "react"
import { getLang, translate, useT } from "../i18n"
import { compactTokens, decimal, ms, percent, shortModel, usd } from "../lab-format"
import type { LabCandidate, LabSummary } from "../types"

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
    label: "MAE vs baseline",
    hint: "Mean |Δ| between the model's mean score and the score in the database, per posting",
    better: "low",
    score: (s) => s.mae,
    render: (s) => decimal(s.mae),
    n: (s) => s.n.mae,
  },
  {
    key: "sd",
    label: "Stability, SD",
    hint: "Mean standard deviation of scores across repeats within a posting",
    better: "low",
    score: (s) => s.stability_sd,
    render: (s) => decimal(s.stability_sd),
    n: (s) => s.n.stability,
  },
  {
    key: "flip",
    label: "Flip rate",
    hint: "Share of postings where repeats landed on opposite sides of the 70 threshold",
    better: "low",
    score: (s) => s.flip_rate,
    render: (s) => percent(s.flip_rate),
    n: (s) => s.n.flip,
  },
  {
    key: "agree",
    label: "Agreement @70",
    hint: "Share of postings where the ping / no-ping decision by the majority of repeats matched the baseline",
    better: "high",
    score: (s) => s.agreement70,
    render: (s) => percent(s.agreement70),
    n: (s) => s.n.agreement,
  },
  {
    key: "recall",
    label: "Recall on labeled",
    hint: "Share of postings you applied to, interviewed for, or saved where the mean score is at least 70",
    better: "high",
    score: (s) => s.labeled_recall,
    render: (s) => percent(s.labeled_recall),
    n: (s) => s.n.labeled,
  },
  {
    key: "german",
    label: "“German” flag",
    hint: "Share of postings where german_required matched the baseline",
    better: "high",
    score: (s) => s.german_flag_match,
    render: (s) => percent(s.german_flag_match),
    n: (s) => s.n.german,
  },
  {
    key: "errors",
    label: "Errors",
    hint: "Failed attempts out of all finished ones",
    better: "low",
    score: errorShare,
    render: (s) =>
      translate(getLang(), "{share} · {failed} of {total}", {
        share: percent(errorShare(s)),
        failed: s.n_failed,
        total: s.n_ok + s.n_failed,
      }),
  },
  {
    key: "p50",
    label: "Latency p50 / p95",
    hint: "Median and 95th percentile of a successful attempt's duration",
    better: "low",
    score: (s) => s.p50_ms,
    render: (s) => `${ms(s.p50_ms)} / ${ms(s.p95_ms)}`,
    n: (s) => s.n.latency,
  },
  {
    key: "tokens",
    label: "Tokens in / out / thoughts",
    hint: "Average per attempt; output includes reasoning",
    render: (s) => `${compactTokens(s.avg_in)} / ${compactTokens(s.avg_out)} / ${compactTokens(s.avg_thought)}`,
    n: (s) => s.n.tokens,
  },
  {
    key: "cost",
    label: "Run cost",
    hint: "Tokens times the model price per million",
    better: "low",
    score: (s) => s.cost_usd,
    render: (s) => usd(s.cost_usd),
  },
  {
    key: "per_job",
    label: "Per posting",
    hint: "Average cost of one attempt",
    better: "low",
    score: (s) => s.cost_per_job_usd,
    render: (s) => usd(s.cost_per_job_usd),
  },
  {
    key: "monthly",
    label: "Monthly forecast",
    hint: "Cost per posting × 9,000 postings a month",
    better: "low",
    score: (s) => s.monthly_usd,
    render: (s) => usd(s.monthly_usd),
  },
]

/** Candidates holding the best value per metric; nothing when fewer than two compare or all tie. */
export function bestByMetric(summary: LabSummary[]): Map<string, Set<number>> {
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

export function CandidateCard({
  candidate,
  summary,
  best,
}: {
  candidate: LabCandidate
  summary: LabSummary | undefined
  best: Map<string, Set<number>>
}) {
  const t = useT()
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
                <dt title={t(metric.hint)}>{t(metric.label)}</dt>
                <dd className={isBest ? "is-best" : undefined}>
                  {metric.render(summary)}
                  {metric.n ? <span className="lab-n">n={metric.n(summary)}</span> : null}
                </dd>
              </Fragment>
            )
          })}
        </dl>
      ) : (
        <p className="muted">{t("No answers yet")}</p>
      )}
    </article>
  )
}
