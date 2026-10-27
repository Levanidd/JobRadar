import { getLang } from "./i18n"
import type {
  AutoRunSchedule,
  Cycle,
  CycleRunLog,
  CompanyFacet,
  DetectResult,
  DiscoveredCompany,
  ExploreBoard,
  ExploreCompany,
  InterviewStage,
  Job,
  JobStatus,
  LabCandidateInput,
  LabJobDetail,
  LabPreview,
  LabRun,
  LabRunDetail,
  LabRunInput,
  LabRunList,
  ModelBatchDetail,
  ModelBatchLog,
  ModelOption,
  RunResult,
  BlacklistedCompany,
  PrefilterRules,
  ScoringProvider,
  Settings,
  Source,
  JobStats,
  ThinkingLevel,
  Tier,
  AuthUser,
  ManagedUser,
} from "./types"

const STORAGE_KEY = "jobradar.token"

let token = sessionStorage.getItem(STORAGE_KEY) ?? ""

export class UnauthorizedError extends Error {
  constructor() {
    super("Invalid token")
  }
}

/** Keeps the response body, for screens that show more of an error than its text. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly payload: unknown,
  ) {
    super(message)
  }
}

export function getToken(): string {
  return token
}

export function setToken(value: string): void {
  token = value
  sessionStorage.setItem(STORAGE_KEY, value)
}

export function forgetToken(): void {
  token = ""
  sessionStorage.removeItem(STORAGE_KEY)
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set("Authorization", `Bearer ${token}`)
  headers.set("Accept-Language", getLang())
  if (init?.body) headers.set("Content-Type", "application/json")

  const res = await fetch(`/api${path}`, { ...init, headers })
  if (res.status === 401) throw new UnauthorizedError()

  const payload: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error: unknown }).error)
        : `Error ${res.status}`
    throw new ApiError(message, res.status, payload)
  }
  return payload as T
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined })
}

export type JobSort =
  | "applied"
  | "viewed"
  | "later"
  | "title"
  | "company"
  | "score"
  | "posted"
  | "updated"
  | "added"

export type JobFilters = {
  status?: string
  min_score?: number
  companies?: string[]
  source_id?: number
  source_label?: string
  tier?: string
  added_days?: number
  added_from?: string
  viewed?: "yes" | "no"
  later?: "yes" | "no"
  applied?: "yes" | "no"
  sort?: JobSort
  dir?: "asc" | "desc"
  limit?: number
  offset?: number
}

function jobQuery(filters: JobFilters): string {
  const params = new URLSearchParams()
  if (filters.status) params.set("status", filters.status)
  if (filters.min_score) params.set("min_score", String(filters.min_score))
  if (filters.companies?.length) params.set("companies", filters.companies.join(","))
  if (filters.source_id) params.set("source_id", String(filters.source_id))
  if (filters.tier) params.set("tier", filters.tier)
  if (filters.added_days) params.set("added_days", String(filters.added_days))
  if (filters.added_from) params.set("added_from", filters.added_from)
  if (filters.viewed) params.set("viewed", filters.viewed)
  if (filters.later) params.set("later", filters.later)
  if (filters.applied) params.set("applied", filters.applied)
  if (filters.sort) params.set("sort", filters.sort)
  if (filters.dir) params.set("dir", filters.dir)
  if (filters.limit) params.set("limit", String(filters.limit))
  if (filters.offset) params.set("offset", String(filters.offset))
  const query = params.toString()
  return query ? `?${query}` : ""
}

/** Every job PATCH answers with the fields the list and the detail card show. */
export type JobPatch = {
  ok: true
  status: JobStatus
  notes: string | null
  applied_at: string | null
  viewed_at: string | null
  later_at: string | null
  interviewed_at: string | null
  cv_url: string | null
  claude_comment: string | null
}

function patchJob(
  id: string,
  body: { status?: JobStatus; notes?: string; viewed?: boolean; later?: boolean },
): Promise<JobPatch> {
  return request(`/jobs/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) })
}

export const api = {
  async verify(): Promise<AuthUser> {
    return request("/me")
  },

  me(): Promise<AuthUser> {
    return request("/me")
  },

  users(): Promise<{ users: ManagedUser[] }> {
    return request("/users")
  },

  createUser(name: string): Promise<{ user: ManagedUser }> {
    return request("/users", { method: "POST", body: JSON.stringify({ name }) })
  },

  updateUser(id: number, body: { name?: string; role?: AuthUser["role"] }): Promise<{ user: ManagedUser }> {
    return request(`/users/${id}`, { method: "PATCH", body: JSON.stringify(body) })
  },

  resetUserToken(id: number): Promise<{ user: ManagedUser }> {
    return post(`/users/${id}/token`)
  },

  userProfile(id: number): Promise<{
    user: AuthUser
    content: string
    prefilter?: PrefilterRules
    blacklist?: BlacklistedCompany[]
    companies?: BlacklistedCompany[]
  }> {
    return request(`/users/${id}/profile`)
  },

  saveUserProfile(
    id: number,
    body: { content?: string; prefilter?: PrefilterRules; blacklist?: BlacklistedCompany[] },
  ): Promise<{
    ok: true
    prefilter?: PrefilterRules
    applied?: { dropped: number; restored: number }
    blacklist?: BlacklistedCompany[]
  }> {
    return request(`/users/${id}/profile`, { method: "PUT", body: JSON.stringify(body) })
  },

  rescoreUser(id: number): Promise<{ ok: true; scored: number }> {
    return post(`/users/${id}/rescore`)
  },

  jobs(filters: JobFilters): Promise<{ jobs: Job[]; has_more: boolean; next_offset: number }> {
    return request(`/jobs${jobQuery(filters)}`)
  },

  jobCompanies(filters: JobFilters, q?: string): Promise<{ companies: CompanyFacet[] }> {
    const base = jobQuery({ ...filters, companies: undefined, source_label: undefined, sort: undefined, dir: undefined })
    const params = new URLSearchParams(base.startsWith("?") ? base.slice(1) : "")
    const needle = q?.trim()
    if (needle) params.set("q", needle)
    const query = params.toString()
    return request(`/jobs/companies${query ? `?${query}` : ""}`)
  },

  setJobStatus(id: string, status: JobStatus): Promise<JobPatch> {
    return patchJob(id, { status })
  },

  setJobViewed(id: string, viewed: boolean): Promise<JobPatch> {
    return patchJob(id, { viewed })
  },

  setJobLater(id: string, later: boolean): Promise<JobPatch> {
    return patchJob(id, { later })
  },

  saveJobNotes(id: string, notes: string): Promise<JobPatch> {
    return patchJob(id, { notes })
  },

  job(id: string): Promise<{ job: Job }> {
    return request(`/jobs/${encodeURIComponent(id)}`)
  },

  addStage(jobId: string, body: { title: string; happened_on?: string | null }): Promise<{ stages: InterviewStage[] }> {
    return request(`/jobs/${encodeURIComponent(jobId)}/stages`, { method: "POST", body: JSON.stringify(body) })
  },

  updateStage(
    jobId: string,
    stageId: number,
    body: { title?: string; happened_on?: string | null },
  ): Promise<{ stages: InterviewStage[] }> {
    return request(`/jobs/${encodeURIComponent(jobId)}/stages/${stageId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    })
  },

  deleteStage(jobId: string, stageId: number): Promise<{ stages: InterviewStage[] }> {
    return request(`/jobs/${encodeURIComponent(jobId)}/stages/${stageId}`, { method: "DELETE" })
  },

  setJobPrimary(id: string): Promise<{ job: Job }> {
    return post(`/jobs/${encodeURIComponent(id)}/primary`)
  },

  applied(status?: string, interviewed?: "yes" | "no", company?: string): Promise<{ jobs: Job[] }> {
    const params = new URLSearchParams()
    if (status) params.set("status", status)
    if (interviewed) params.set("interviewed", interviewed)
    const name = company?.trim()
    if (name) params.set("company", name)
    const query = params.toString()
    return request(`/applied${query ? `?${query}` : ""}`)
  },

  appliedCompanies(status?: string, interviewed?: "yes" | "no"): Promise<{ companies: { company: string; jobs: number }[] }> {
    const params = new URLSearchParams()
    if (status) params.set("status", status)
    if (interviewed) params.set("interviewed", interviewed)
    const query = params.toString()
    return request(`/applied/companies${query ? `?${query}` : ""}`)
  },

  stats(days?: number): Promise<JobStats> {
    return request(days ? `/stats?days=${days}` : "/stats")
  },

  createApplied(body: {
    title: string
    company: string
    url: string
    location?: string
    description?: string
    notes?: string
    salary_min?: number | null
    salary_max?: number | null
    salary_currency?: string
    status?: "applied" | "interview"
    applied_at?: string
  }): Promise<{ job: Job }> {
    return request("/applied", { method: "POST", body: JSON.stringify(body) })
  },

  scoreJob(id: string): Promise<{
    id: string
    score: number
    score_reason: string | null
    flags: string | null
    status: JobStatus
  }> {
    return post(`/jobs/${encodeURIComponent(id)}/score`)
  },

  scoreJobs(ids: string[]): Promise<{
    jobs: Array<{
      id: string
      score: number
      score_reason: string | null
      flags: string | null
      status: JobStatus
    }>
  }> {
    return post("/jobs/score", { ids })
  },

  discovered(): Promise<{ companies: DiscoveredCompany[] }> {
    return request("/discovered")
  },

  addDiscovered(key: string): Promise<{ added: boolean; ats: string | null }> {
    return post(`/discovered/${encodeURIComponent(key)}/add`)
  },

  dismissDiscovered(key: string): Promise<{ ok: true }> {
    return post(`/discovered/${encodeURIComponent(key)}/dismiss`)
  },

  exploreBoards(): Promise<{ boards: ExploreBoard[] }> {
    return request("/explore/boards")
  },

  explorePrepare(providers: string[]): Promise<{
    sources: { id: number; label: string; provider: string }[]
    created: number
  }> {
    return post("/explore/prepare", { providers })
  },

  explore(providers: string[]): Promise<{ companies: ExploreCompany[] }> {
    const query = encodeURIComponent(providers.join(","))
    return request(`/explore?providers=${query}`)
  },

  addExplore(key: string): Promise<{ added: boolean; ats: string | null }> {
    return post(`/explore/${encodeURIComponent(key)}/add`)
  },

  sources(): Promise<{ sources: Source[] }> {
    return request("/sources")
  },

  createSource(body: {
    kind: "company" | "query"
    tier: Tier
    label: string
    provider: string
    token: string
    careers_url?: string
  }): Promise<{ ok: true }> {
    return post("/sources", body)
  },

  updateSource(id: number, body: { enabled?: number; tier?: Tier; label?: string }): Promise<{ ok: true }> {
    return request(`/sources/${id}`, { method: "PATCH", body: JSON.stringify(body) })
  },

  deleteSource(id: number): Promise<{ ok: true }> {
    return request(`/sources/${id}`, { method: "DELETE" })
  },

  runSource(id: number, options: { score?: boolean } = {}): Promise<{ run: RunResult; scored: number }> {
    return post(`/sources/${id}/run${options.score === false ? "?score=0" : ""}`)
  },

  cycle(): Promise<Cycle> {
    return request("/run")
  },

  startCycle(): Promise<Cycle> {
    return post("/run")
  },

  autoRun(): Promise<AutoRunSchedule> {
    return request("/run/schedule")
  },

  saveAutoRun(body: { enabled: boolean; times: string[] }): Promise<AutoRunSchedule> {
    return request("/run/schedule", { method: "PUT", body: JSON.stringify(body) })
  },

  runLog(page: number): Promise<CycleRunLog> {
    return request(`/run/log?page=${page}`)
  },

  modelBatches(page: number): Promise<ModelBatchLog> {
    return request(`/model/batches?page=${page}`)
  },

  modelBatch(id: number): Promise<ModelBatchDetail> {
    return request(`/model/batches/${id}`)
  },

  detect(url: string): Promise<DetectResult> {
    return post("/detect", { url })
  },

  profile(): Promise<{
    content: string
    prefilter?: PrefilterRules
    blacklist?: BlacklistedCompany[]
    companies?: BlacklistedCompany[]
  }> {
    return request("/profile")
  },

  saveProfile(content: string): Promise<{ ok: true; prefilter?: PrefilterRules }> {
    return request("/profile", { method: "PUT", body: JSON.stringify({ content }) })
  },

  savePrefilter(prefilter: PrefilterRules): Promise<{
    ok: true
    prefilter: PrefilterRules
    applied?: { dropped: number; restored: number }
  }> {
    return request("/profile", { method: "PUT", body: JSON.stringify({ prefilter }) })
  },

  saveBlacklist(blacklist: BlacklistedCompany[]): Promise<{ ok: true; blacklist: BlacklistedCompany[] }> {
    return request("/profile", { method: "PUT", body: JSON.stringify({ blacklist }) })
  },

  rescore(): Promise<{ ok: true; scored: number }> {
    return post("/profile/rescore")
  },

  profilePrompt(): Promise<{ prompt: string }> {
    return request("/profile/prompt")
  },

  saveProfilePrompt(prompt: string): Promise<{ prompt: string }> {
    return request("/profile/prompt", { method: "PUT", body: JSON.stringify({ prompt }) })
  },

  settings(): Promise<Settings> {
    return request("/settings")
  },

  models(provider: ScoringProvider): Promise<{ models: ModelOption[]; error?: string }> {
    return request(`/models?provider=${provider}`)
  },

  saveSettings(body: {
    provider?: ScoringProvider
    model?: string
    thinking_level?: ThinkingLevel
  }): Promise<Settings> {
    return request("/settings", { method: "PUT", body: JSON.stringify(body) })
  },

  labPreview(
    body: Partial<LabRunInput> & { clone_from?: number; candidates: LabCandidateInput[] },
  ): Promise<LabPreview> {
    return post("/lab/preview", body)
  },

  labRuns(page: number): Promise<LabRunList> {
    return request(`/lab/runs?page=${page}`)
  },

  createLabRun(body: LabRunInput): Promise<{ run: LabRun; warnings: string[] }> {
    return post("/lab/runs", body)
  },

  cloneLabRun(
    id: number,
    body: { name?: string; repeats: number; candidates: LabCandidateInput[] },
  ): Promise<{ run: LabRun; warnings: string[] }> {
    return post(`/lab/runs/${id}/clone`, body)
  },

  labRun(id: number): Promise<LabRunDetail> {
    return request(`/lab/runs/${id}`)
  },

  labJob(id: number, jobId: string): Promise<LabJobDetail> {
    return request(`/lab/runs/${id}/jobs/${encodeURIComponent(jobId)}`)
  },

  labTick(id: number): Promise<{ ok: true; more: boolean; kicked: boolean }> {
    return post(`/lab/runs/${id}/tick`)
  },

  cancelLabRun(id: number): Promise<{ run: LabRun }> {
    return post(`/lab/runs/${id}/cancel`)
  },

  retryLabRun(id: number, trialIds?: number[]): Promise<{ run: LabRun }> {
    return post(`/lab/runs/${id}/retry`, trialIds ? { trial_ids: trialIds } : {})
  },

  deleteLabRun(id: number): Promise<{ ok: true }> {
    return request(`/lab/runs/${id}`, { method: "DELETE" })
  },

  /** The export needs the auth header, so it is fetched and handed to the browser as a file. */
  async downloadLabCsv(id: number): Promise<void> {
    const res = await fetch(`/api/lab/runs/${id}/export.csv`, { headers: { Authorization: `Bearer ${token}` } })
    if (res.status === 401) throw new UnauthorizedError()
    if (!res.ok) throw new Error(`Error ${res.status}`)
    const url = URL.createObjectURL(await res.blob())
    const link = document.createElement("a")
    link.href = url
    link.download = `lab-run-${id}.csv`
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  },
}
