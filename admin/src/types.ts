import type { ScoringProvider, ThinkingLevel } from "../../shared/domain"
import type { CyclePhase, CycleStatus, JobStatus, LabStatus, LabTrialStatus } from "../../shared/domain"
import type { SampleMode as LabSampleMode, Stratum as LabStratum } from "../../shared/domain"

/** Shared with the Worker: see shared/domain.ts. */
export type {
  AuthUser,
  CyclePhase,
  CycleStatus,
  JobStatus,
  LabStatus,
  LabTrialStatus,
  ManagedUser,
  ModelOption,
  ScoringProvider,
  ThinkingLevel,
} from "../../shared/domain"
export type { SampleMode as LabSampleMode, Stratum as LabStratum } from "../../shared/domain"

export type Tier = "watchlist" | "discovery"

export type Job = {
  id: string
  source_id: number
  company: string
  company_key: string
  title: string
  location: string | null
  url: string
  posted_at: string | null
  first_seen_at: string
  last_seen_at: string
  changed_at?: string | null
  salary_min?: number | null
  salary_max?: number | null
  salary_currency?: string | null
  score: number | null
  score_reason: string | null
  flags: string | null
  status: JobStatus
  applied_at: string | null
  viewed_at: string | null
  later_at: string | null
  interviewed_at: string | null
  notes?: string | null
  cv_url?: string | null
  claude_comment?: string | null
  description?: string | null
  tier: Tier
  source_label: string
  duplicate_of?: string | null
  duplicates?: JobDuplicate[]
  stages?: InterviewStage[]
}

export type InterviewStage = {
  id: number
  title: string
  /** `YYYY-MM-DD`; a round can be noted before its date is known. */
  happened_on: string | null
}

export type JobDuplicate = {
  id: string
  url: string
  title: string
  company: string
  source_label: string
  kind: string
  first_seen_at: string
  primary: boolean
}

export type CompanyFacet = {
  company_key: string
  company: string
  jobs: number
}

export type ExploreBoard = {
  provider: string
  label: string
  jobs: number
  ready: boolean
  sources: { id: number; label: string; enabled: number; jobs: number }[]
}

export type ExploreCompany = {
  company_key: string
  company: string
  jobs: number
  best_score: number | null
  sample_url: string | null
  providers: string
}

export type DiscoveredCompany = {
  company_key: string
  company: string
  first_seen_at: string
  /** How many times the ingest walked over this company's postings. */
  hits: number
  /** Postings we actually hold for it right now. */
  jobs_open: number
  best_score: number | null
  sample_url: string | null
  careers_url: string | null
  detected_ats: string | null
  state: "new" | "added" | "dismissed"
}

export type Source = {
  id: number
  kind: "company" | "query"
  tier: Tier
  label: string
  provider: string
  token: string
  careers_url: string | null
  enabled: number
  last_run_at: string | null
  last_count: number | null
  bootstrapped: number
  active_jobs: number
  last_error: string | null
  last_ok: number | null
  created_at: string
}

export type DetectResult = {
  ats: string | null
  token: string | null
  ok: boolean
  jobs_found: number
  sample: string[]
  guessed: boolean
  error?: string
}

export type ModelSource = "database" | "secret" | "default"

export type ProviderSettings = {
  id: ScoringProvider
  label: string
  key_name: string
  key_configured: boolean
  model: string
  source: ModelSource
}

export type Settings = {
  provider: ScoringProvider
  model: string
  thinking_level: ThinkingLevel
  source: ModelSource
  key_configured: boolean
  providers: ProviderSettings[]
}

export type PrefilterRules = {
  keep: string[]
  drop: string[]
}

export type BlacklistedCompany = {
  company_key: string
  company: string
}

export type StatsBucket = {
  start: string
  applied: number
  interview: number
  rejected: number
  total: number
}

export type JobStats = {
  found: number
  open: number
  viewed: number
  later: number
  applied: number
  pipeline: {
    waiting: number
    interview: number
    rejected: number
  }
  companies: Array<{ company_key: string; company: string; n: number }>
  weeks: StatsBucket[]
  months: StatsBucket[]
}

export type RunResult = {
  source_id: number
  ok: boolean
  jobs_found: number
  jobs_new: number
  error: string | null
  duration_ms: number
  suspicious: number
}

export type Cycle = {
  status: CycleStatus
  phase: CyclePhase
  done: number
  total: number
  source_total: number
  current: string
  current_id: number | null
  found: number
  fresh: number
  failed: number
  scored: number
  notified: number
  error: string | null
  updated_at: string | null
}

export type AutoRunSchedule = {
  enabled: boolean
  times: string[]
  timezone: string
}

export type CycleRunEntry = {
  id: number
  kind: "manual" | "auto"
  status: CycleStatus
  started_at: string
  finished_at: string | null
  sources: number
  found: number
  fresh: number
  failed: number
  scored: number
  error: string | null
  user_name: string | null
  input_tokens: number
  output_tokens: number
}

export type ModelBatchKind = "cycle" | "score" | "source" | "rescore" | "job" | "check" | "lab"

export type ModelBatch = {
  id: number
  kind: ModelBatchKind
  run_id: number | null
  trigger: "manual" | "auto"
  model: string | null
  started_at: string
  finished_at: string
  requests: number
  jobs: number
  failed: number
  duration_ms: number
  input_tokens: number
  output_tokens: number
  user_name: string | null
  user_role: "master" | "user" | null
}

export type ModelBatchLog = {
  batches: ModelBatch[]
  total: number
  page: number
  page_size: number
}

export type ModelRequest = {
  id: number
  model: string
  started_at: string
  finished_at: string
  duration_ms: number
  jobs: number
  input_tokens: number
  output_tokens: number
  thought_tokens: number
  ok: number
  error: string | null
}

export type ModelBatchDetail = {
  batch: ModelBatch
  requests: ModelRequest[]
}

export type CycleRunLog = {
  runs: CycleRunEntry[]
  total: number
  page: number
  page_size: number
}

// ---------- model lab ----------

export type LabRun = {
  id: number
  name: string
  status: LabStatus
  user_id: number
  user_name: string | null
  created_by: number
  sample_mode: LabSampleMode
  include_labeled: boolean
  sample_size: number
  repeats: number
  seed: number
  cloned_from: number | null
  prompt_hash: string
  /** The production model when the run was created: the likely, not certain, author of the baseline. */
  baseline_model: string | null
  total: number
  done: number
  failed: number
  error: string | null
  created_at: string
  started_at: string | null
  updated_at: string | null
  finished_at: string | null
  /** Live, but nothing has moved for a while; a tick restarts it. */
  stale: boolean
}

export type LabCandidate = {
  id: number
  position: number
  provider: ScoringProvider
  model: string
  thinking_level: ThinkingLevel | null
  price_in_per_m: number | null
  price_out_per_m: number | null
}

export type LabRunListItem = LabRun & {
  jobs: number
  candidates: Array<
    Pick<LabCandidate, "id" | "provider" | "model" | "thinking_level" | "price_in_per_m" | "price_out_per_m">
  >
  cost_usd: number | null
  /** At least one model had no price, so the cost leaves it out. */
  cost_partial: boolean
}

export type LabRunList = {
  runs: LabRunListItem[]
  total: number
  page: number
  page_size: number
}

export type LabJob = {
  job_id: string
  position: number
  stratum: LabStratum | null
  title: string
  company: string
  location: string | null
  url: string | null
  baseline_score: number | null
  baseline_reason: string | null
  baseline_flags: string | null
  baseline_status: JobStatus | null
}

export type LabTrial = {
  id: number
  candidate_id: number
  job_id: string
  repeat_no: number
  exec_order: number
  status: LabTrialStatus
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

export type LabRunDetail = {
  run: LabRun
  candidates: LabCandidate[]
  jobs: LabJob[]
  trials: LabTrial[]
  cells: LabCell[]
  summary: LabSummary[]
  cycle_running: boolean
}

export type LabJobDetail = {
  job: LabJob & { description: string }
  trials: Array<{ id: number; raw_response: string | null }>
}

export type LabPreview = {
  pool_size: number
  by_stratum: Record<LabStratum, number>
  sample_size: number
  trials: number
  est_cost_usd: number | null
  warnings: string[]
  /** Why a launch would be refused right now; the form keeps its button off. */
  error: string | null
}

export type LabCandidateInput = {
  provider: ScoringProvider
  model: string
  thinking_level?: ThinkingLevel | null
  price_in_per_m?: number | null
  price_out_per_m?: number | null
}

export type LabRunInput = {
  name?: string
  user_id: number
  sample_size: number
  sample_mode: LabSampleMode
  include_labeled: boolean
  repeats: number
  seed: number
  candidates: LabCandidateInput[]
}
