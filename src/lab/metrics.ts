export const PING_THRESHOLD = 70
/** Postings a month the production scorer sees; turns cost per posting into a monthly bill. */
export const LAB_MONTHLY_JOBS = 9000

const POSITIVE_LABELS = ["applied", "interview", "saved"]

export type MetricCandidate = {
  id: number
  price_in_per_m: number | null
  price_out_per_m: number | null
}

export type MetricJob = {
  job_id: string
  baseline_score: number | null
  baseline_flags: string | null
  baseline_status: string | null
}

export type MetricTrial = {
  candidate_id: number
  job_id: string
  exec_order: number
  status: string
  score: number | null
  flags: string | null
  input_tokens: number | null
  output_tokens: number | null
  thought_tokens: number | null
  duration_ms: number | null
}

export type LabCell = {
  candidate_id: number
  job_id: string
  scores: number[]
  mean: number | null
  spread: number | null
  delta: number | null
  flip: boolean
  agree: boolean | null
  unstable_flags: string[]
  n_ok: number
  n_failed: number
  n_waiting: number
}

export type LabSummary = {
  candidate_id: number
  n_ok: number
  n_failed: number
  mae: number | null
  stability_sd: number | null
  flip_rate: number | null
  agreement70: number | null
  labeled_recall: number | null
  german_flag_match: number | null
  p50_ms: number | null
  p95_ms: number | null
  avg_in: number | null
  avg_out: number | null
  avg_thought: number | null
  cost_usd: number | null
  cost_per_job_usd: number | null
  monthly_usd: number | null
  /** How many postings (or trials, for latency and tokens) each metric stands on. */
  n: {
    mae: number
    stability: number
    flip: number
    agreement: number
    labeled: number
    german: number
    latency: number
    tokens: number
  }
}

export function parseFlags(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((flag): flag is string => typeof flag === "string") : []
  } catch {
    return []
  }
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}

function standardDeviation(values: number[]): number {
  const avg = mean(values) ?? 0
  return Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length)
}

/** Nearest-rank percentile, so p50 and p95 are always durations that actually happened. */
function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]
}

/** A tie between repeats falls back to the mean, so two repeats can still decide. */
function majorityPings(scores: number[]): boolean {
  const pings = scores.filter((score) => score >= PING_THRESHOLD).length
  if (pings * 2 !== scores.length) return pings * 2 > scores.length
  return (mean(scores) ?? 0) >= PING_THRESHOLD
}

function majorityHas(flagSets: string[][], flag: string): boolean {
  return flagSets.filter((flags) => flags.includes(flag)).length * 2 > flagSets.length
}

function share(hits: boolean[]): number | null {
  return hits.length ? hits.filter(Boolean).length / hits.length : null
}

function byExecOrder(a: MetricTrial, b: MetricTrial): number {
  return a.exec_order - b.exec_order
}

export function labCell(job: MetricJob, candidateId: number, trials: MetricTrial[]): LabCell {
  const own = trials.filter((trial) => trial.candidate_id === candidateId && trial.job_id === job.job_id).sort(byExecOrder)
  const ok = own.filter((trial) => trial.status === "ok" && trial.score !== null)
  const scores = ok.map((trial) => trial.score as number)
  const avg = mean(scores)
  const flagSets = ok.map((trial) => parseFlags(trial.flags))
  const seen = [...new Set(flagSets.flat())]
  return {
    candidate_id: candidateId,
    job_id: job.job_id,
    scores,
    mean: avg,
    spread: scores.length ? Math.max(...scores) - Math.min(...scores) : null,
    delta: avg !== null && job.baseline_score !== null ? avg - job.baseline_score : null,
    flip: scores.some((score) => score >= PING_THRESHOLD) && scores.some((score) => score < PING_THRESHOLD),
    agree:
      scores.length && job.baseline_score !== null
        ? majorityPings(scores) === job.baseline_score >= PING_THRESHOLD
        : null,
    unstable_flags: seen.filter((flag) => !flagSets.every((flags) => flags.includes(flag))),
    n_ok: ok.length,
    n_failed: own.filter((trial) => trial.status === "failed").length,
    n_waiting: own.filter((trial) => trial.status === "pending" || trial.status === "running").length,
  }
}

export function labSummary(
  candidate: MetricCandidate,
  jobs: MetricJob[],
  trials: MetricTrial[],
  cells: LabCell[],
): LabSummary {
  const own = trials.filter((trial) => trial.candidate_id === candidate.id)
  const ok = own.filter((trial) => trial.status === "ok" && trial.score !== null)
  const byJob = new Map(cells.filter((cell) => cell.candidate_id === candidate.id).map((cell) => [cell.job_id, cell]))
  const answered = jobs
    .map((job) => ({ job, cell: byJob.get(job.job_id) }))
    .filter((item): item is { job: MetricJob; cell: LabCell } => Boolean(item.cell && item.cell.n_ok > 0))

  const deltas = answered.flatMap(({ cell }) => (cell.delta === null ? [] : [Math.abs(cell.delta)]))
  const repeated = answered.filter(({ cell }) => cell.scores.length >= 2)
  const agreements = answered.flatMap(({ cell }) => (cell.agree === null ? [] : [cell.agree]))
  const labeled = answered.filter(({ job }) => POSITIVE_LABELS.includes(job.baseline_status ?? ""))
  const german = answered.map(({ job }) => {
    const flagSets = ok.filter((trial) => trial.job_id === job.job_id).map((trial) => parseFlags(trial.flags))
    return majorityHas(flagSets, "german_required") === parseFlags(job.baseline_flags).includes("german_required")
  })

  const durations = ok.flatMap((trial) => (trial.duration_ms === null ? [] : [trial.duration_ms]))
  const metered = own.filter((trial) => trial.input_tokens !== null)
  const priced = candidate.price_in_per_m !== null && candidate.price_out_per_m !== null
  const cost = priced
    ? metered.reduce(
        (sum, trial) =>
          sum +
          ((trial.input_tokens ?? 0) * (candidate.price_in_per_m as number) +
            (trial.output_tokens ?? 0) * (candidate.price_out_per_m as number)) /
            1_000_000,
        0,
      )
    : null
  const perJob = cost !== null && metered.length ? cost / metered.length : null

  return {
    candidate_id: candidate.id,
    n_ok: ok.length,
    n_failed: own.filter((trial) => trial.status === "failed").length,
    mae: mean(deltas),
    stability_sd: mean(repeated.map(({ cell }) => standardDeviation(cell.scores))),
    flip_rate: share(repeated.map(({ cell }) => cell.flip)),
    agreement70: share(agreements),
    labeled_recall: share(labeled.map(({ cell }) => (cell.mean ?? 0) >= PING_THRESHOLD)),
    german_flag_match: share(german),
    p50_ms: percentile(durations, 50),
    p95_ms: percentile(durations, 95),
    avg_in: mean(metered.map((trial) => trial.input_tokens ?? 0)),
    avg_out: mean(metered.map((trial) => trial.output_tokens ?? 0)),
    avg_thought: mean(metered.map((trial) => trial.thought_tokens ?? 0)),
    cost_usd: cost,
    cost_per_job_usd: perJob,
    monthly_usd: perJob === null ? null : perJob * LAB_MONTHLY_JOBS,
    n: {
      mae: deltas.length,
      stability: repeated.length,
      flip: repeated.length,
      agreement: agreements.length,
      labeled: labeled.length,
      german: german.length,
      latency: durations.length,
      tokens: metered.length,
    },
  }
}

export function labMetrics(
  candidates: MetricCandidate[],
  jobs: MetricJob[],
  trials: MetricTrial[],
): { cells: LabCell[]; summary: LabSummary[] } {
  const cells = jobs.flatMap((job) => candidates.map((candidate) => labCell(job, candidate.id, trials)))
  return { cells, summary: candidates.map((candidate) => labSummary(candidate, jobs, trials, cells)) }
}

export const CSV_COLUMNS = [
  "run_id",
  "job_id",
  "title",
  "company",
  "stratum",
  "baseline_score",
  "baseline_status",
  "provider",
  "model",
  "thinking_level",
  "repeat_no",
  "status",
  "score",
  "flags",
  "reason",
  "input_tokens",
  "output_tokens",
  "thought_tokens",
  "duration_ms",
  "error_code",
] as const

export type CsvRow = Record<(typeof CSV_COLUMNS)[number], string | number | null>

/**
 * Sheets and Excel run a cell that starts with = + - @ as a formula, and model
 * reasons sometimes start with a dash, so such text gets a leading apostrophe.
 */
function csvCell(value: string | number | null): string {
  if (value === null) return ""
  let text = String(value)
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** The BOM is what makes Excel read the file as UTF-8; Google Sheets accepts it either way. */
export function toCsv(rows: CsvRow[]): string {
  const lines = [CSV_COLUMNS.join(","), ...rows.map((row) => CSV_COLUMNS.map((column) => csvCell(row[column])).join(","))]
  return `\uFEFF${lines.join("\r\n")}\r\n`
}
