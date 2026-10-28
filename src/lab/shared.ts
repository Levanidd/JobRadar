import { pick } from "../locale"
import type { LabCell, LabSummary } from "./metrics"
import type { SampleMode, Stratum } from "./sample"
import type { ScoringErrorCode, ScoringProvider, ThinkingLevel } from "../scoring"
import type { Bindings } from "../types"

export const LAB_CONCURRENCY = 4
export const LAB_MAX_TRIALS = 300
export const MAX_CANDIDATES = 6
export const MAX_SAMPLE = 30
export const MAX_REPEATS = 5
export const NAME_MAX = 80
export const TRIAL_TIMEOUT_MS = 60_000
/** waitUntil dies around 30 s; a walk stops starting new hops before that. */
export const WALK_BUDGET_MS = 25_000
export const HEARTBEAT_MS = 10_000
export const MAX_ATTEMPTS = 3
export const MAX_HOPS = 2000
export const RATE_LIMIT_PAUSE_MS = 10_000
export const RAW_LIMIT = 4000
export const ERROR_LIMIT = 500
export const DETAIL_CONCURRENCY = 6
export const POOL_CACHE_MS = 2 * 60_000
export const PRICE_CACHE_MS = 10 * 60_000
export const PAGE_SIZE = 10
/** Mixed into the seed so the execution order is not the same stream as the sample. */
export const EXEC_SALT = 0x5bd1e995
/** Rough size of one clipped posting in tokens, for the cost estimate before any lab call exists. */
export const DESCRIPTION_TOKENS = 900
export const DEFAULT_OUTPUT_TOKENS = 250

export const LIVE = `status IN ('queued', 'running')`
export const STALE = `datetime('now', '-25 seconds')`
export const RETRYABLE: ScoringErrorCode[] = ["http_429", "http_5xx", "timeout"]
/**
 * Listed rather than `<> 'off_profile'` so the (user_id, status, score) index
 * seeks past the parked rows instead of reading every one of them.
 */
export const POOL_STATUSES = ["new", "notified", "saved", "applied", "interview", "rejected", "ignored"]

export const emptyPool = () => pick("No scored postings for this profile", "Нет оценённых вакансий для этого профиля")

export type LabStatus = "queued" | "running" | "done" | "error" | "cancelled"

export type LabRunRow = {
  id: number
  name: string
  created_by: number
  user_id: number
  status: LabStatus
  sample_mode: SampleMode
  include_labeled: number
  sample_size: number
  repeats: number
  seed: number
  cloned_from: number | null
  profile_snapshot: string
  system_prompt: string
  prompt_hash: string
  baseline_model: string | null
  usage_batch_id: number | null
  total: number
  done: number
  failed: number
  hops: number
  error: string | null
}

export type LabRunView = {
  id: number
  name: string
  status: LabStatus
  user_id: number
  user_name: string | null
  created_by: number
  sample_mode: SampleMode
  include_labeled: boolean
  sample_size: number
  repeats: number
  seed: number
  cloned_from: number | null
  prompt_hash: string
  baseline_model: string | null
  total: number
  done: number
  failed: number
  error: string | null
  created_at: string
  started_at: string | null
  updated_at: string | null
  finished_at: string | null
  /** Live but nothing has moved for a while: the walker died or handed the run back, and a tick will pick it up. */
  stale: boolean
}

export type RunViewRow = Omit<LabRunView, "include_labeled" | "stale"> & { include_labeled: number; stale: number | null }

export type LabCandidate = {
  id: number
  position: number
  provider: ScoringProvider
  model: string
  thinking_level: ThinkingLevel | null
  price_in_per_m: number | null
  price_out_per_m: number | null
}

export type LabJob = {
  job_id: string
  position: number
  stratum: Stratum | null
  title: string
  company: string
  location: string | null
  url: string | null
  baseline_score: number | null
  baseline_reason: string | null
  baseline_flags: string | null
  baseline_status: string | null
}

export type LabTrial = {
  id: number
  candidate_id: number
  job_id: string
  repeat_no: number
  exec_order: number
  status: "pending" | "running" | "ok" | "failed" | "cancelled"
  score: number | null
  reason: string | null
  flags: string | null
  error_code: string | null
  error: string | null
  attempts: number
  input_tokens: number | null
  output_tokens: number | null
  thought_tokens: number | null
  duration_ms: number | null
}

export type LabRunDetail = {
  run: LabRunView
  candidates: LabCandidate[]
  jobs: LabJob[]
  trials: LabTrial[]
  cells: LabCell[]
  summary: LabSummary[]
  cycle_running: boolean
}

export type CandidateInput = {
  provider: ScoringProvider
  model: string
  thinking_level: ThinkingLevel | null
  price_in_per_m: number | null
  price_out_per_m: number | null
}

export type LabParams = {
  name: string
  user_id: number
  sample_size: number
  sample_mode: SampleMode
  include_labeled: boolean
  repeats: number
  seed: number
  candidates: CandidateInput[]
}

export type LabError = { error: string; candidate_errors?: Array<{ index: number; error: string }> }
export type LabResult<T> = { status: 200 | 201 | 400 | 404 | 409; body: T | LabError }

export function bad(error: string): LabResult<never> {
  return { status: 400, body: { error } }
}

export const NOT_FOUND: LabResult<never> = { status: 404, body: { error: "not found" } }

export async function activeRun(env: Bindings): Promise<number | null> {
  const row = await env.DB.prepare(`SELECT id FROM lab_runs WHERE ${LIVE} ORDER BY id LIMIT 1`).first<{ id: number }>()
  return row?.id ?? null
}

export function busy(id: number): LabResult<never> {
  return { status: 409, body: { error: pick(`Wait for run #${id} to finish`, `Дождитесь завершения прогона #${id}`) } }
}
