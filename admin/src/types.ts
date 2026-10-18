export type AuthUser = {
  id: number
  name: string
  role: "master" | "user"
}

/** Master-only view: `token` is null for a master who still logs in with ADMIN_TOKEN. */
export type ManagedUser = AuthUser & { token: string | null }

export type Tier = "watchlist" | "discovery"

export type JobStatus =
  | "new"
  | "notified"
  | "saved"
  | "applied"
  | "interview"
  | "rejected"
  | "ignored"
  /** Title did not match the prefilter, so it was never scored. */
  | "off_profile"

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

export type ThinkingLevel = "LOW" | "MEDIUM" | "HIGH"

export type ModelOption = { id: string; label: string }

export type ScoringProvider = "gemini" | "nebius"

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

export type CycleStatus = "idle" | "running" | "done" | "error"

export type CyclePhase = "sources" | "scoring" | "digest"

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

export type ModelBatchKind = "cycle" | "score" | "source" | "rescore" | "job" | "check"

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
