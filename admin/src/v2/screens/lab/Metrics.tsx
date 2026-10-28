import { useT } from "../../../i18n"
import { compactTokens, decimal, ms, percent, shortModel, usd } from "../../../lab-format"
import type { LabCandidate, LabSummary } from "../../../types"
import { Swatch } from "./shared"

type Metric = {
  key: string
  label: string
  /** A short line under the name; the formula sits in `hint`. */
  sub?: string
  hint: string
  /** Which way is better; metrics without one are shown but never highlighted. */
  better?: "low" | "high"
  score?: (summary: LabSummary) => number | null
  render: (summary: LabSummary, t: (english: string, vars?: Record<string, string | number>) => string) => string
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
    sub: "lower is closer to the current score",
    hint: "Mean |Δ| between the model's mean score and the score in the database, per posting",
    better: "low",
    score: (s) => s.mae,
    render: (s) => decimal(s.mae),
    n: (s) => s.n.mae,
  },
  {
    key: "sd",
    label: "Stability, SD",
    sub: "spread between repeats",
    hint: "Mean standard deviation of scores across repeats within a posting",
    better: "low",
    score: (s) => s.stability_sd,
    render: (s) => decimal(s.stability_sd),
    n: (s) => s.n.stability,
  },
  {
    key: "flip",
    label: "Flip rate",
    sub: "repeats on both sides of 70",
    hint: "Share of postings where repeats landed on opposite sides of the 70 threshold",
    better: "low",
    score: (s) => s.flip_rate,
    render: (s) => percent(s.flip_rate),
    n: (s) => s.n.flip,
  },
  {
    key: "agree",
    label: "Agreement @70",
    sub: "the same ping decision as the baseline",
    hint: "Share of postings where the ping / no-ping decision by the majority of repeats matched the baseline",
    better: "high",
    score: (s) => s.agreement70,
    render: (s) => percent(s.agreement70),
    n: (s) => s.n.agreement,
  },
  {
    key: "recall",
    label: "Recall on labeled",
    sub: "did it find what you applied to",
    hint: "Share of postings you applied to, interviewed for, or saved where the mean score is at least 70",
    better: "high",
    score: (s) => s.labeled_recall,
    render: (s) => percent(s.labeled_recall),
    n: (s) => s.n.labeled,
  },
  {
    key: "german",
    label: "“German” flag",
    sub: "matches the baseline",
    hint: "Share of postings where german_required matched the baseline",
    better: "high",
    score: (s) => s.german_flag_match,
    render: (s) => percent(s.german_flag_match),
    n: (s) => s.n.german,
  },
  {
    key: "errors",
    label: "Errors",
    sub: "failed of finished attempts",
    hint: "Failed attempts out of all finished ones",
    better: "low",
    score: errorShare,
    render: (s, t) =>
      t("{share} · {failed} of {total}", {
        share: percent(errorShare(s)),
        failed: s.n_failed,
        total: s.n_ok + s.n_failed,
      }),
  },
  {
    key: "p50",
    label: "Latency p50 / p95",
    sub: "of a successful attempt",
    hint: "Median and 95th percentile of a successful attempt's duration",
    better: "low",
    score: (s) => s.p50_ms,
    render: (s) => `${ms(s.p50_ms)} / ${ms(s.p95_ms)}`,
    n: (s) => s.n.latency,
  },
  {
    key: "tokens",
    label: "Tokens in / out / thoughts",
    sub: "average per request",
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
    sub: "one attempt",
    hint: "Average cost of one attempt",
    better: "low",
    score: (s) => s.cost_per_job_usd,
    render: (s) => usd(s.cost_per_job_usd),
  },
  {
    key: "monthly",
    label: "Monthly forecast",
    sub: "at 9,000 postings a month",
    hint: "Cost per posting × 9,000 postings a month",
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

export function Metrics({
  candidates,
  summary,
  baselineModel,
}: {
  candidates: LabCandidate[]
  summary: LabSummary[]
  baselineModel: string | null
}) {
  const t = useT()
  const byId = new Map(summary.map((item) => [item.candidate_id, item]))
  const best = bestByMetric(summary)

  return (
    <section className="card lab2-table-card" aria-labelledby="lab2-metrics-h">
      <div className="lab2-table-head">
        <h2 id="lab2-metrics-h" className="lab2-h2">
          {t("Model comparison")}
        </h2>
        <span className="lab2-caption">
          {t(
            "The baseline is the current score in the database ({model}). It is a reference point, not the truth. The best value in each row is highlighted; n is how many postings or attempts it was computed on.",
            { model: baselineModel ?? t("unknown") },
          )}
        </span>
      </div>
      <div className="lab2-scroll">
        <table className="lab2-table lab2-metrics" style={{ minWidth: 260 + candidates.length * 170 }}>
          <thead>
            <tr>
              <th scope="col" className="lab2-metric-col">
                {t("Metric")}
              </th>
              {candidates.map((candidate, index) => (
                <th key={candidate.id} scope="col" className="lab2-model-col" title={candidate.model}>
                  <span className="lab2-model-head">
                    <Swatch index={index} />
                    <span className="mono">{shortModel(candidate.model)}</span>
                  </span>
                  <span className="lab2-model-tags">
                    {candidate.provider === "gemini" ? "Gemini" : "Nebius"}
                    {candidate.thinking_level ? ` · thinking ${candidate.thinking_level.toLowerCase()}` : ""}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {METRICS.map((metric) => (
              <tr key={metric.key}>
                <th scope="row" className="lab2-metric-name" title={t(metric.hint)}>
                  {t(metric.label)}
                  {metric.sub ? <span className="lab2-metric-sub">{t(metric.sub)}</span> : null}
                </th>
                {candidates.map((candidate) => {
                  const item = byId.get(candidate.id)
                  if (!item) {
                    return (
                      <td key={candidate.id} className="faint">
                        {metric.key === "mae" ? t("No answers yet") : "—"}
                      </td>
                    )
                  }
                  const isBest = best.get(metric.key)?.has(candidate.id) ?? false
                  return (
                    <td key={candidate.id}>
                      <span className={`lab2-value${isBest ? " is-best" : ""}`}>
                        {metric.render(item, t)}
                        {isBest ? <span className="sr-only"> ({t("best")})</span> : null}
                      </span>
                      {metric.n ? <span className="lab2-n">n={metric.n(item)}</span> : null}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
