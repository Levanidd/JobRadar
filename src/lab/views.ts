import { placeholders } from "../db"
import { labMetrics, parseFlags, toCsv, type CsvRow } from "./metrics"
import type { Bindings } from "../types"
import { type LabCandidate, type LabJob, type LabRunDetail, type LabRunView, type LabTrial, PAGE_SIZE, type RunViewRow, STALE } from "./shared"

const RUN_VIEW = `SELECT r.id, r.name, r.status, r.user_id, u.name AS user_name, r.created_by, r.sample_mode,
    r.include_labeled, r.sample_size, r.repeats, r.seed, r.cloned_from, r.prompt_hash, r.baseline_model,
    r.total, r.done, r.failed, r.error, r.created_at, r.started_at, r.updated_at, r.finished_at,
    r.status IN ('queued', 'running') AND (r.updated_at IS NULL OR r.updated_at < ${STALE}) AS stale`

function runView(row: RunViewRow): LabRunView {
  return { ...row, include_labeled: Boolean(row.include_labeled), stale: Boolean(row.stale) }
}

export async function loadRunView(env: Bindings, id: number): Promise<LabRunView | null> {
  const row = await env.DB.prepare(`${RUN_VIEW} FROM lab_runs r LEFT JOIN users u ON u.id = r.user_id WHERE r.id = ?`)
    .bind(id)
    .first<RunViewRow>()
  return row ? runView(row) : null
}

export type LabRunListItem = LabRunView & {
  jobs: number
  candidates: Array<
    Pick<LabCandidate, "id" | "provider" | "model" | "thinking_level" | "price_in_per_m" | "price_out_per_m">
  >
  cost_usd: number | null
  cost_partial: boolean
}

export async function listLabRuns(
  env: Bindings,
  page: number,
): Promise<{ runs: LabRunListItem[]; total: number; page: number; page_size: number }> {
  const [rows, count] = await Promise.all([
    env.DB.prepare(
      `${RUN_VIEW}, (SELECT COUNT(*) FROM lab_jobs j WHERE j.lab_run_id = r.id) AS jobs
       FROM lab_runs r LEFT JOIN users u ON u.id = r.user_id
       ORDER BY r.id DESC LIMIT ? OFFSET ?`,
    )
      .bind(PAGE_SIZE, (page - 1) * PAGE_SIZE)
      .all<RunViewRow & { jobs: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM lab_runs`).first<{ n: number }>(),
  ])
  const ids = rows.results.map((row) => row.id)
  const [candidates, costs] = ids.length
    ? await Promise.all([
        env.DB.prepare(
          `SELECT id, lab_run_id, provider, model, thinking_level, price_in_per_m, price_out_per_m
           FROM lab_candidates WHERE lab_run_id IN (${placeholders(ids.length)}) ORDER BY lab_run_id, position`,
        )
          .bind(...ids)
          .all<LabCandidate & { lab_run_id: number }>(),
        env.DB.prepare(
          `SELECT t.lab_run_id,
             SUM((COALESCE(t.input_tokens, 0) * c.price_in_per_m + COALESCE(t.output_tokens, 0) * c.price_out_per_m) / 1000000.0) AS cost
           FROM lab_trials t JOIN lab_candidates c ON c.id = t.candidate_id
           WHERE t.lab_run_id IN (${placeholders(ids.length)})
             AND c.price_in_per_m IS NOT NULL AND c.price_out_per_m IS NOT NULL
           GROUP BY t.lab_run_id`,
        )
          .bind(...ids)
          .all<{ lab_run_id: number; cost: number | null }>(),
      ])
    : [{ results: [] }, { results: [] }]
  const costByRun = new Map(costs.results.map((row) => [row.lab_run_id, row.cost]))
  return {
    runs: rows.results.map((row) => {
      const own = candidates.results.filter((candidate) => candidate.lab_run_id === row.id)
      return {
        ...runView(row),
        jobs: row.jobs,
        candidates: own.map(({ id, provider, model, thinking_level, price_in_per_m, price_out_per_m }) => ({
          id,
          provider,
          model,
          thinking_level,
          price_in_per_m,
          price_out_per_m,
        })),
        cost_usd: costByRun.get(row.id) ?? null,
        cost_partial: own.some((candidate) => candidate.price_in_per_m === null || candidate.price_out_per_m === null),
      }
    }),
    total: Number(count?.n ?? 0),
    page,
    page_size: PAGE_SIZE,
  }
}

/** Four reads and at most ~340 rows; descriptions and raw replies stay out until a row is opened. */
export async function loadLabRun(env: Bindings, id: number): Promise<LabRunDetail | null> {
  const [run, candidates, jobs, trials] = await Promise.all([
    env.DB.prepare(
      `${RUN_VIEW}, (SELECT status FROM cycles WHERE id = 1) = 'running' AS cycle_running
       FROM lab_runs r LEFT JOIN users u ON u.id = r.user_id WHERE r.id = ?`,
    )
      .bind(id)
      .first<RunViewRow & { cycle_running: number | null }>(),
    env.DB.prepare(
      `SELECT id, position, provider, model, thinking_level, price_in_per_m, price_out_per_m
       FROM lab_candidates WHERE lab_run_id = ? ORDER BY position`,
    )
      .bind(id)
      .all<LabCandidate>(),
    env.DB.prepare(
      `SELECT job_id, position, stratum, title, company, location, url,
         baseline_score, baseline_reason, baseline_flags, baseline_status
       FROM lab_jobs WHERE lab_run_id = ? ORDER BY position`,
    )
      .bind(id)
      .all<LabJob>(),
    env.DB.prepare(
      `SELECT id, candidate_id, job_id, repeat_no, exec_order, status, score, reason, flags, error_code, error,
         attempts, input_tokens, output_tokens, thought_tokens, duration_ms
       FROM lab_trials WHERE lab_run_id = ? ORDER BY exec_order`,
    )
      .bind(id)
      .all<LabTrial>(),
  ])
  if (!run) return null
  const { cycle_running, ...rest } = run
  const { cells, summary } = labMetrics(candidates.results, jobs.results, trials.results)
  return {
    run: runView(rest),
    candidates: candidates.results,
    jobs: jobs.results,
    trials: trials.results,
    cells,
    summary,
    cycle_running: Boolean(cycle_running),
  }
}

export async function loadLabJob(
  env: Bindings,
  runId: number,
  jobId: string,
): Promise<{ job: LabJob & { description: string }; trials: Array<{ id: number; raw_response: string | null }> } | null> {
  const [job, trials] = await Promise.all([
    env.DB.prepare(
      `SELECT job_id, position, stratum, title, company, location, url, description,
         baseline_score, baseline_reason, baseline_flags, baseline_status
       FROM lab_jobs WHERE lab_run_id = ? AND job_id = ?`,
    )
      .bind(runId, jobId)
      .first<LabJob & { description: string }>(),
    env.DB.prepare(`SELECT id, raw_response FROM lab_trials WHERE lab_run_id = ? AND job_id = ? ORDER BY exec_order`)
      .bind(runId, jobId)
      .all<{ id: number; raw_response: string | null }>(),
  ])
  return job ? { job, trials: trials.results } : null
}

export async function labCsv(env: Bindings, id: number): Promise<string | null> {
  const run = await env.DB.prepare(`SELECT id FROM lab_runs WHERE id = ?`).bind(id).first()
  if (!run) return null
  const rows = await env.DB.prepare(
    `SELECT t.job_id, j.title, j.company, j.stratum, j.baseline_score, j.baseline_status,
       c.provider, c.model, c.thinking_level, t.repeat_no, t.status, t.score, t.flags, t.reason,
       t.input_tokens, t.output_tokens, t.thought_tokens, t.duration_ms, t.error_code
     FROM lab_trials t
     JOIN lab_jobs j ON j.lab_run_id = t.lab_run_id AND j.job_id = t.job_id
     JOIN lab_candidates c ON c.id = t.candidate_id
     WHERE t.lab_run_id = ?
     ORDER BY j.position, c.position, t.repeat_no`,
  )
    .bind(id)
    .all<Omit<CsvRow, "run_id">>()
  return toCsv(
    rows.results.map((row) => ({
      run_id: id,
      ...row,
      flags: row.flags === null ? null : parseFlags(String(row.flags)).join(" "),
    })),
  )
}

// ---------- execution ----------
